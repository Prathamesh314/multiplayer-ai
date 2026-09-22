/*
 * One persistent branch/worktree per room repository, backed by a bare cache
 * shared by rooms of the same project on this user's device. The cloud owns
 * accepted heads; turns still push candidates through server verification.
 */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { AgentRunJob } from "../app/lib/ai/run-events";
import { withWorkspaceLock } from "./workspace-lock";

const run = promisify(execFile);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const CONFIG = ["-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", "-c", "gc.auto=0", "-c", "maintenance.auto=false"];
type WorkspaceJob = Pick<AgentRunJob, "sessionId" | "repoId" | "projectId" | "userId" | "baseSha" | "turnId">;
type Binding = { version: 1; repoRef: string; cacheKey: string };

export type RunnerWorkspace = {
  path: string;
  branch: string;
  /** Only valid during withWorkspace; creates and pushes this turn's candidate. */
  commitAndPush(message: string, author: { name: string; email: string }): Promise<string | null>;
};

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false; throw cause; }
}

export class RunnerGit {
  constructor(private readonly server: string, private readonly token: string, private readonly dataDir: string) {}

  private async git(cwd: string, args: string[], turnId?: string): Promise<string> {
    // A runner launched from another worktree must not inherit its Git paths.
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
    const auth = turnId ? ["-c", `http.extraHeader=Authorization: Bearer ${this.token}`, "-c", `http.extraHeader=X-Turn-Id: ${turnId}`] : [];
    try {
      const { stdout } = await run("git", [...CONFIG, ...auth, ...args], {
        cwd, env: { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
        timeout: 120_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true,
      });
      return stdout;
    } catch (cause) {
      // execFile's message includes argv, which contains the device token.
      const detail = (cause as { stderr?: string }).stderr || "could not execute Git";
      throw new Error(`Git ${args[0]} failed: ${this.token ? detail.split(this.token).join("[redacted]") : detail}`);
    }
  }

  private remoteUrl(repoRef: string): string {
    return `${this.server.replace(/\/$/, "")}/api/git/${encodeURIComponent(repoRef)}`;
  }

  /** The callback owns this workspace across agent execution and candidate push. */
  async withWorkspace<T>(job: WorkspaceJob, task: (workspace: RunnerWorkspace) => Promise<T>): Promise<T> {
    const repoRef = job.repoId ?? job.sessionId;
    if (!/^[a-zA-Z0-9_-]+$/.test(repoRef) || !job.userId ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(job.turnId) ||
        !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(job.baseSha)) {
      throw new Error("Invalid workspace job identity or base commit.");
    }
    const scope = digest(`${this.server.replace(/\/$/, "")}\0${job.userId}`);
    const root = resolve(this.dataDir, "workspaces-v1", scope);
    const key = digest(repoRef);
    const work = join(root, "work", key);
    const branch = `workspace/${key}`;
    return withWorkspaceLock(join(root, "locks", `workspace-${key}`), job.turnId, async () => {
      // Pin the cache choice so old queued jobs without projectId keep their
      // workspace when a newer server starts supplying the field.
      const bindingPath = join(root, "bindings", `${key}.json`);
      let binding: Binding;
      if (await exists(bindingPath)) {
        binding = JSON.parse(await readFile(bindingPath, "utf8")) as Binding;
        if (binding.version !== 1 || binding.repoRef !== repoRef || !/^[0-9a-f]{64}$/.test(binding.cacheKey)) {
          throw new Error(`Workspace metadata needs recovery: ${bindingPath}. Existing files were preserved.`);
        }
      } else {
        binding = { version: 1, repoRef, cacheKey: digest(!job.repoId && job.projectId ? `project:${job.projectId}` : `repo:${repoRef}`) };
        await mkdir(dirname(bindingPath), { recursive: true, mode: 0o700 });
        const temp = `${bindingPath}.${randomUUID()}.tmp`;
        await writeFile(temp, JSON.stringify(binding), { mode: 0o600 });
        await rename(temp, bindingPath);
      }
      const cache = join(root, "repos", `${binding.cacheKey}.git`);
      const cacheLock = join(root, "locks", `cache-${binding.cacheKey}`);
      const lockedGit = <R>(action: () => Promise<R>) => withWorkspaceLock(cacheLock, job.turnId, action, 125_000);
      const attempt = `refs/runner-attempts/${job.turnId}`;

      await lockedGit(async () => {
        if (!await exists(cache)) {
          await mkdir(dirname(cache), { recursive: true, mode: 0o700 });
          const temp = `${cache}.${randomUUID()}.tmp`;
          await this.git(dirname(cache), ["init", "--bare", temp]);
          await rename(temp, cache);
        }
        // Fetch only the authorized room, even when other rooms share objects.
        // Credentials and remote URLs are per-command, never persisted.
        const remoteRef = `refs/remotes/rooms/${key}`;
        await this.git(cache, ["fetch", "--no-tags", "--no-write-fetch-head", this.remoteUrl(repoRef), `+refs/heads/session/${repoRef}:${remoteRef}`], job.turnId);
        await this.git(cache, ["merge-base", "--is-ancestor", job.baseSha, remoteRef]);
        if (await this.hasRef(cache, attempt)) throw new Error("This turn already started locally. Recover its result instead of replaying the agent.");

        if (!await exists(work)) {
          await mkdir(dirname(work), { recursive: true, mode: 0o700 });
          // Never force: a leftover branch/registration may hold undelivered work.
          await this.git(cache, ["worktree", "add", "-b", branch, work, job.baseSha]);
        } else {
          if (!(await lstat(join(work, ".git"))).isFile() ||
              await realpath((await this.git(work, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim()) !== await realpath(cache)) {
            throw new Error(`Workspace does not belong to its repository cache: ${work}. Files were preserved.`);
          }
          await this.checkBranch(work, branch);
          if ((await this.git(work, ["status", "--porcelain", "--untracked-files=all"])).trim()) {
            throw new Error(`Workspace has unfinished edits: ${work}. Review and save or move them before starting another turn; nothing was reset or cleaned.`);
          }
          const head = (await this.git(work, ["rev-parse", "HEAD"])).trim();
          if (head !== job.baseSha) {
            try { await this.git(work, ["merge-base", "--is-ancestor", head, job.baseSha]); }
            catch { throw new Error(`Workspace has commits not included in the assigned code version: ${work}. Recover or publish that work before continuing; it was preserved.`); }
            // Also protect ignored configuration when upstream starts tracking it.
            await this.git(work, ["merge", "--ff-only", "--no-autostash", "--no-overwrite-ignore", job.baseSha]);
          }
        }
        // Durable marker: even a clean workspace cannot replay a paid turn.
        await this.git(cache, ["update-ref", attempt, job.baseSha, ""]);
      });

      let active = true;
      let committed = false;
      const workspace: RunnerWorkspace = {
        path: work, branch,
        commitAndPush: async (message, author) => {
          if (!active || committed) throw new Error("This workspace turn is no longer available for committing.");
          committed = true;
          return lockedGit(async () => {
            await this.checkBranch(work, branch);
            await this.git(work, ["merge-base", "--is-ancestor", job.baseSha, "HEAD"]);
            await this.git(work, ["add", "-A"]);
            if ((await this.git(work, ["status", "--porcelain"])).trim()) {
              await this.git(work, ["-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`, "commit", "-m", message]);
            }
            const sha = (await this.git(work, ["rev-parse", "HEAD"])).trim();
            if (sha === job.baseSha) return null;
            // Keep a named local result even if upload or finalization fails.
            await this.git(cache, ["update-ref", `refs/turns/${job.turnId}`, sha, ""]);
            await this.git(work, ["push", this.remoteUrl(repoRef), `${sha}:refs/turns/${job.turnId}`], job.turnId);
            return sha;
          });
        },
      };
      try { return await task(workspace); }
      finally { active = false; }
    });
  }

  private async hasRef(cache: string, ref: string): Promise<boolean> {
    return Boolean((await this.git(cache, ["for-each-ref", "--format=%(refname)", ref])).trim());
  }

  private async checkBranch(work: string, branch: string): Promise<void> {
    if ((await this.git(work, ["symbolic-ref", "--quiet", "HEAD"])).trim() !== `refs/heads/${branch}`) {
      throw new Error(`Workspace branch changed: ${work}. Restore its workspace branch before continuing; files were preserved.`);
    }
  }
}
