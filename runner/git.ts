import { captureCheckpoint, restoreCheckpoint } from "./checkpoints";
import { checkpointRef, type Checkpoint } from "../app/lib/runner/checkpoint-types";
import type { RunnerApi } from "./api";
/*
 * One persistent branch/worktree per room repository, backed by a bare cache
 * shared by rooms of the same repository on this user's device. A parallel
 * ("isolated") chat gets a worktree and branch of its own instead, based on
 * the chat's server branch, so several can run at once. The cloud owns
 * accepted heads; turns still push candidates through server verification.
 */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, unlink } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { gitCommand } from "../app/lib/git/command";
import type { AgentRunJob } from "../app/lib/ai/run-events";
import { withWorkspaceLock } from "./workspace-lock";
import { allocateWorkspaceLocation, locationPath, prepareWorkspaceParent, readableName, writeWorkspaceMetadata, type WorkspaceLocation } from "./workspace-layout";

const run = promisify(execFile);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const CONFIG = ["-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", "-c", "gc.auto=0", "-c", "maintenance.auto=false"];
type WorkspaceJob = Pick<AgentRunJob, "sessionId" | "repoId" | "projectId" | "projectRepositoryId" | "userId" | "baseSha" | "turnId" | "workspaceNames" | "restoreCheckpoint"> &
  Partial<Pick<AgentRunJob, "runId" | "isolation" | "chatBranch">>;
type Binding = { version: 1; repoRef: string; cacheKey: string; location?: WorkspaceLocation; repositoryName?: string; roomName?: string; sessionId?: string; checkpointOwner?: string; checkpointJob?: { turnId: string; baseSha: string }; checkpointSequence?: number; checkpointTree?: string;
  /** Set for a parallel chat's own worktree; absent for the room's shared one. */
  chatRunId?: string; chatName?: string;
  /** The worktree's local branch, named like its folder. Absent on older worktrees, whose branch is workspace/<key>. */
  branch?: string;
  /** Where an older worktree was before it got its readable name; set only while moving it. */
  previousLocation?: WorkspaceLocation };
/** Older worktrees' branch, named by their workspace key. */
const legacyBranch = (key: string) => `workspace/${key}`;
const branchOf = (binding: Binding, key: string) => binding.branch ?? legacyBranch(key);
const bindingName = (binding: Binding) => readableName(binding.chatRunId ? binding.chatName : binding.roomName, binding.chatRunId ? "chat" : "room");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type RunnerGitOptions = {
  /**
   * Ignored files (exact relative paths, such as ".env.local") copied from the
   * room's shared worktree into a parallel chat's new worktree, so it starts
   * with the same local configuration. Never tracked files; never overwrites.
   */
  copyIgnoredFiles?: string[];
};

export type PruneCandidate = { chat: string; path: string; removable: boolean; reason?: string };

export type RunnerWorkspace = {
  path: string;
  branch: string;
  checkpoint(): Promise<void>;
  /** Only valid during withWorkspace; creates and pushes this turn's candidate. */
  commitAndPush(message: string, author: { name: string; email: string }): Promise<string | null>;
};

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false; throw cause; }
}

export class RunnerGit {
  /** Workspace locks held or awaited by jobs in this process; idle checkpoints skip them. */
  private readonly activeWorkspaces = new Map<string, number>();
  /** Idle checkpoints in progress, which an arriving job waits out instead of failing. */
  private readonly idleCaptures = new Map<string, Promise<void>>();

  constructor(private readonly server: string, private readonly token: string, private readonly dataDir: string, private readonly workspacesDir = join(dataDir, "workspaces"), private readonly options: RunnerGitOptions = {}) {}

  /** Pairing and CLI detection can succeed even when Git cannot start. */
  async checkAvailable(): Promise<void> {
    await this.git(process.cwd(), ["--version"]);
  }

  private scopeRoot(userId: string): string {
    return resolve(this.dataDir, "workspaces-v1", digest(`${this.server.replace(/\/$/, "")}\0${userId}`));
  }

  /** `turnId` authenticates the call for that turn; null authenticates a read with no turn. */
  private async git(repository: string | { bare: string }, args: string[], turnId?: string | null, checkpointSequence?: number): Promise<string> {
    // A runner launched from another worktree must not inherit its Git paths.
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
    // Windows cannot start processes with a cwd beyond MAX_PATH, even when
    // Git supports long filenames. Keep bare-cache commands in the data root.
    const cwd = typeof repository === "string" ? repository : this.dataDir;
    // Git also reserves space within PATH_MAX for explicit GIT_DIR values.
    // A relative cache path leaves room for its own metadata filenames.
    const location = typeof repository === "string" ? [] : [`--git-dir=${relative(cwd, repository.bare) || "."}`];
    const auth = turnId !== undefined ? ["-c", `http.extraHeader=Authorization: Bearer ${this.token}`, ...(turnId ? ["-c", `http.extraHeader=X-Turn-Id: ${turnId}`] : [])] : [];
    try {
      const { stdout } = await run(...gitCommand([...CONFIG, ...auth, ...location, ...(checkpointSequence === undefined ? [] : ["-c", `http.extraHeader=X-Checkpoint-Sequence: ${checkpointSequence}`]), ...args]), {
        cwd, env: { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
        timeout: 120_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true,
      });
      return stdout;
    } catch (cause) {
      // execFile's message includes argv, which contains the device token.
      const detail = (cause as NodeJS.ErrnoException).code === "ENOENT"
        ? "Git was not found. Install Git for your operating system, then restart the runner. On Windows, install Git for Windows with command-line access enabled."
        : (cause as { stderr?: string }).stderr || `could not execute Git (${(cause as NodeJS.ErrnoException).code ?? "unknown error"})`;
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
        !UUID.test(job.turnId) ||
        !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(job.baseSha)) {
      throw new Error("Invalid workspace job identity or base commit.");
    }
    const isolated = job.isolation === "isolated";
    if (isolated && (!job.runId || !UUID.test(job.runId) || job.chatBranch !== `chat/${job.runId}`)) {
      throw new Error("Invalid parallel chat identity.");
    }
    const root = this.scopeRoot(job.userId);
    // A parallel chat's worktree is keyed by the chat as well as the repository.
    const identity = isolated ? `${repoRef}\0chat\0${job.runId}` : repoRef;
    const key = digest(identity);
    const lockPath = join(root, "locks", `workspace-${key}`);
    // Registered before any await, so an idle checkpoint cannot start in between.
    this.activeWorkspaces.set(lockPath, (this.activeWorkspaces.get(lockPath) ?? 0) + 1);
    try {
      await this.idleCaptures.get(lockPath);
      return await this.lockedWorkspace(job, task, { repoRef, isolated, key, root, lockPath });
    } finally {
      const count = (this.activeWorkspaces.get(lockPath) ?? 1) - 1;
      if (count) this.activeWorkspaces.set(lockPath, count); else this.activeWorkspaces.delete(lockPath);
    }
  }

  private async lockedWorkspace<T>(job: WorkspaceJob, task: (workspace: RunnerWorkspace) => Promise<T>, context: {
    repoRef: string; isolated: boolean; key: string; root: string; lockPath: string;
  }): Promise<T> {
    const { repoRef, isolated, key, root, lockPath } = context;
    const legacyWork = join(root, "work", key);
    let branch = legacyBranch(key);
    let work: string;
    return withWorkspaceLock(lockPath, job.turnId, async () => {
      // Pin the cache choice so old queued jobs without repository metadata keep their
      // workspace when a newer server starts supplying the field.
      const bindingPath = join(root, "bindings", `${key}.json`);
      let binding: Binding;
      if (await exists(bindingPath)) {
        binding = JSON.parse(await readFile(bindingPath, "utf8")) as Binding;
        if (binding.version !== 1 || binding.repoRef !== repoRef || !/^[0-9a-f]{64}$/.test(binding.cacheKey) ||
            binding.chatRunId !== (isolated ? job.runId : undefined)) {
          throw new Error(`Workspace metadata needs recovery: ${bindingPath}. Existing files were preserved.`);
        }
      } else {
        binding = { version: 1, repoRef, cacheKey: digest(job.projectRepositoryId ? `repository:${job.projectRepositoryId}` : `repo:${repoRef}`),
          ...(isolated ? { chatRunId: job.runId, chatName: job.workspaceNames?.chat } : {}) };
        await mkdir(dirname(bindingPath), { recursive: true, mode: 0o700 });
        await writeWorkspaceMetadata(bindingPath, binding);
      }
      const cache = join(root, "repos", `${binding.cacheKey}.git`);
      const cacheLock = join(root, "locks", `cache-${binding.cacheKey}`);
      const lockedGit = <R>(action: () => Promise<R>) => withWorkspaceLock(cacheLock, job.turnId, action, 125_000);
      const attempt = `refs/runner-attempts/${job.turnId}`;

      await lockedGit(async () => {
        if (!binding.location) {
          binding.repositoryName = job.workspaceNames?.repository;
          binding.roomName = job.workspaceNames?.room;
          if (isolated) binding.chatName = job.workspaceNames?.chat;
          let name = "";
          binding.location = await allocateWorkspaceLocation({ workspacesDir: this.workspacesDir, metadataRoot: root,
            cacheKey: binding.cacheKey, repoRef, repositoryName: job.workspaceNames?.repository,
            chooseName: async (folder) => (name = await this.freeName(root, key, binding, folder, cache, bindingName(binding))) });
          // Brand-new worktrees take the readable name as their branch too.
          if (!await exists(legacyWork)) binding.branch = name;
          binding.sessionId = job.sessionId;
          // Pin the destination before moving, so an interrupted upgrade can
          // find either the old path or the verified destination on restart.
          await writeWorkspaceMetadata(bindingPath, binding);
        }
        work = locationPath(binding.location);
        await prepareWorkspaceParent(binding.location);
        if (await exists(legacyWork)) {
          if (await exists(work)) throw new Error(`Both old and new workspace paths exist. Recover ${legacyWork} and ${work}; neither was overwritten.`);
          await this.checkWorktree(legacyWork, cache, legacyBranch(key));
          // Git updates both ends of the linked worktree, including its index.
          // Dirty, untracked and ignored files travel together; no reset/copy.
          await this.git({ bare: cache }, ["worktree", "move", legacyWork, work]);
        }
        if (await exists(cache)) {
          await this.adoptReadableName(root, key, bindingPath, binding, cache);
          work = locationPath(binding.location!);
        }
        branch = branchOf(binding, key);
        if (!await exists(cache)) {
          await mkdir(dirname(cache), { recursive: true, mode: 0o700 });
          // Git init resolves its directory before reading core.longpaths.
          // Initialize in a short sibling, then atomically publish the cache.
          const temp = await mkdtemp(join(this.dataDir, "repo-init-"));
          await this.git({ bare: temp }, ["init", "--bare"]);
          await rename(temp, cache);
        }
        // Also applies to Git invoked by the AI inside this runner-owned repo.
        // Do not change the member's global or system Git settings.
        if (process.platform === "win32") await this.git({ bare: cache }, ["config", "core.longpaths", "true"]);
        // Fetch only the authorized room (or chat), even when other rooms share
        // objects. Credentials and remote URLs are per-command, never persisted.
        const remoteRef = isolated ? `refs/remotes/chats/${key}` : `refs/remotes/rooms/${key}`;
        const source = isolated ? `refs/heads/${job.chatBranch}` : `refs/heads/session/${repoRef}`;
        await this.git({ bare: cache }, ["fetch", "--no-tags", "--no-write-fetch-head", this.remoteUrl(repoRef), `+${source}:${remoteRef}`], job.turnId);
        await this.git({ bare: cache }, ["merge-base", "--is-ancestor", job.baseSha, remoteRef]);
        if (await this.hasRef(cache, attempt)) throw new Error("This turn already started locally. Recover its result instead of replaying the agent.");

        if (!await exists(work)) {
          await mkdir(dirname(work), { recursive: true, mode: 0o700 });
          // Never force: a leftover branch/registration may hold undelivered work.
          await this.git({ bare: cache }, ["worktree", "add", "-b", branch, work, job.baseSha]);
          if (isolated) await this.copyIgnoredFiles(root, digest(repoRef), work);
        } else {
          await this.checkWorktree(work, cache, branch);
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
        if (job.restoreCheckpoint) {
          const snapshot = job.restoreCheckpoint;
          if (snapshot.baseSha !== job.baseSha && snapshot.headSha !== job.baseSha) throw new Error("The repository advanced since this checkpoint. Review it before restoring.");
          await this.git({ bare: cache }, ["fetch", "--no-tags", this.remoteUrl(repoRef), `${checkpointRef(snapshot)}:${checkpointRef(snapshot)}`], job.turnId);
          if ((await this.git({ bare: cache }, ["rev-parse", checkpointRef(snapshot)])).trim() !== snapshot.snapshotSha) throw new Error("Checkpoint ref does not match its recorded content.");
          await restoreCheckpoint(work, snapshot);
        }
        binding.checkpointOwner = digest(`${this.server}\0${this.token}`);
        binding.checkpointJob = { turnId: job.turnId, baseSha: job.baseSha };
        binding.checkpointSequence = 0;
        binding.checkpointTree = undefined;
        await writeWorkspaceMetadata(bindingPath, binding);
        // Durable marker: even a clean workspace cannot replay a paid turn.
        await this.git({ bare: cache }, ["update-ref", attempt, job.baseSha, ""]);
      });

      let active = true;
      let committed = false;
      const workspace: RunnerWorkspace = {
        path: work!, branch,
        checkpoint: async () => {
          if (!active) throw new Error("Workspace turn ended.");
          await lockedGit(() => this.capture(bindingPath, binding, work, cache, branch));
        },
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
            await this.git({ bare: cache }, ["update-ref", `refs/turns/${job.turnId}`, sha, ""]);
            await this.git(work, ["push", this.remoteUrl(repoRef), `${sha}:refs/turns/${job.turnId}`], job.turnId);
            return sha;
          });
        },
      };
      try { return await task(workspace); }
      finally { active = false; }
    });
  }

  /**
   * Seed a new parallel-chat worktree with allowlisted local configuration
   * from the room's shared worktree. Only regular files that Git ignores
   * there are copied, and nothing already present is overwritten.
   */
  private async copyIgnoredFiles(root: string, sharedKey: string, work: string): Promise<void> {
    const paths = this.options.copyIgnoredFiles ?? [];
    if (!paths.length) return;
    let shared: string;
    try {
      const binding = JSON.parse(await readFile(join(root, "bindings", `${sharedKey}.json`), "utf8")) as Binding;
      if (!binding.location) return;
      shared = await realpath(locationPath(binding.location));
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
      throw cause;
    }
    for (const relativePath of paths) {
      if (!/^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/.test(relativePath) || relativePath.split("/").some(part => part === "." || part === "..")) continue;
      const from = join(shared, ...relativePath.split("/"));
      const to = join(work, ...relativePath.split("/"));
      try {
        const info = await lstat(from);
        if (!info.isFile() || info.size > 1024 * 1024) continue;
        // A symlinked parent directory must not lead outside the shared worktree.
        if (!(await realpath(from)).startsWith(shared + sep)) continue;
        await this.git(shared, ["check-ignore", "--quiet", "--no-index", "--", relativePath]);
        if (await exists(to)) continue;
        await mkdir(dirname(to), { recursive: true, mode: 0o700 });
        await copyFile(from, to);
      } catch {
        // Missing, tracked or unreadable files are simply not copied.
      }
    }
  }

  /**
   * Parallel-chat worktrees whose chats are finished (`finished` holds their
   * run ids). Removal is an explicit user action; with `apply`, each clean
   * worktree whose commits the server already holds is removed, and anything
   * else is reported and left alone.
   */
  async pruneChatWorkspaces(userId: string, finished: Set<string>, apply: boolean): Promise<PruneCandidate[]> {
    const root = this.scopeRoot(userId);
    const results: PruneCandidate[] = [];
    for (const file of await readdir(join(root, "bindings")).catch(() => [] as string[])) {
      if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
      const key = file.slice(0, -5);
      const bindingPath = join(root, "bindings", file);
      const binding = JSON.parse(await readFile(bindingPath, "utf8")) as Binding;
      if (!binding.chatRunId || !finished.has(binding.chatRunId) || !binding.location) continue;
      const work = locationPath(binding.location);
      const cache = join(root, "repos", `${binding.cacheKey}.git`);
      const branch = branchOf(binding, key);
      const lockPath = join(root, "locks", `workspace-${key}`);
      const candidate: PruneCandidate = { chat: binding.chatName || binding.chatRunId, path: work, removable: false };
      results.push(candidate);
      if (this.activeWorkspaces.has(lockPath)) { candidate.reason = "a turn is running"; continue; }
      const remoteRef = `refs/remotes/chats/${key}`;
      const check = async () => {
        if (!await exists(work)) return "already removed";
        await this.checkWorktree(work, cache, branch);
        if ((await this.git(work, ["status", "--porcelain", "--untracked-files=all"])).trim()) return "it has unsaved edits";
        // A local turn ref is written before its push, so it proves nothing:
        // the server's own chat branch must already contain every commit.
        await this.git({ bare: cache }, ["fetch", "--no-tags", "--no-write-fetch-head", this.remoteUrl(binding.repoRef), `+refs/heads/chat/${binding.chatRunId}:${remoteRef}`], null);
        try { await this.git({ bare: cache }, ["merge-base", "--is-ancestor", branch, remoteRef]); }
        catch { return "it has commits the server does not have"; }
        return null;
      };
      try {
        const blocked = await check();
        if (blocked === "already removed") { candidate.reason = blocked; if (apply) await unlink(bindingPath); continue; }
        if (blocked) { candidate.reason = blocked; continue; }
        candidate.removable = true;
        if (!apply) continue;
        await withWorkspaceLock(lockPath, randomUUID(), () => withWorkspaceLock(join(root, "locks", `cache-${binding.cacheKey}`), randomUUID(), async () => {
          if (await check()) throw new Error("The worktree changed while it was being removed; it was preserved.");
          // Without --force, Git itself refuses a worktree with untracked or modified files.
          await this.git({ bare: cache }, ["worktree", "remove", work]);
          await this.git({ bare: cache }, ["branch", "-D", branch]);
          await this.git({ bare: cache }, ["update-ref", "-d", remoteRef]);
          await unlink(bindingPath);
        }, 125_000));
      } catch (cause) {
        candidate.removable = false;
        candidate.reason = cause instanceof Error ? cause.message : String(cause);
      }
    }
    return results;
  }

  private checkpointDirectory() {
    return join(this.dataDir, "checkpoint-outbox", digest(`${this.server}\0${this.token}`));
  }

  private async capture(bindingPath: string, binding: Binding, work: string, cache: string, branch: string) {
    const job = binding.checkpointJob;
    if (!job || (binding.checkpointSequence ?? 0) >= 120) return;
    await this.checkWorktree(work, cache, branch);
    const sequence = (binding.checkpointSequence ?? 0) + 1;
    const snapshot = await captureCheckpoint(work, cache, job.turnId, job.baseSha, sequence, binding.checkpointTree);
    if (!snapshot) return;
    const tree = (await this.git({ bare: cache }, ["rev-parse", `${snapshot.snapshotSha}^{tree}`])).trim() + ":" +
      (await this.git({ bare: cache }, ["rev-parse", `${snapshot.indexSha}^{tree}`])).trim() + ":" + snapshot.headSha;
    if (binding.checkpointTree === tree) return;
    binding.checkpointSequence = sequence;
    await writeWorkspaceMetadata(bindingPath, binding);
    await this.git({ bare: cache }, ["update-ref", checkpointRef(snapshot), snapshot.snapshotSha, ""]);
    const directory = this.checkpointDirectory();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeWorkspaceMetadata(join(directory, `${snapshot.id}.json`), { snapshot, repoRef: binding.repoRef, cache });
    binding.checkpointSequence = sequence;
    binding.checkpointTree = tree;
    await writeWorkspaceMetadata(bindingPath, binding);
  }

  /**
   * The worktree a terminal for this chat should open in: a parallel chat's
   * own, else its room repository's. Null when none exists on this computer
   * yet (the first AI turn here creates it).
   */
  async terminalDirectory(input: { userId: string; repoRef: string | null; runId: string | null; isolated: boolean }): Promise<{ path: string; label: string } | null> {
    if (!input.userId || !input.repoRef || !/^[a-zA-Z0-9_-]+$/.test(input.repoRef)) return null;
    const root = this.scopeRoot(input.userId);
    const candidates = [
      ...(input.isolated && input.runId && UUID.test(input.runId) ? [digest(`${input.repoRef}\0chat\0${input.runId}`)] : []),
      digest(input.repoRef),
    ];
    for (const key of candidates) {
      try {
        const bindingPath = join(root, "bindings", `${key}.json`);
        let binding = JSON.parse(await readFile(bindingPath, "utf8")) as Binding;
        if (binding.repoRef !== input.repoRef || !binding.location) continue;
        binding = await this.tidyIdle(root, key, bindingPath, binding);
        const path = locationPath(binding.location!);
        // Just the repository and the worktree's (= branch's) readable name.
        if ((await lstat(path)).isDirectory()) return { path, label: `${binding.repositoryName || "repository"} · ${binding.branch ?? bindingName(binding)}` };
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      }
    }
    return null;
  }

  /**
   * A readable name no other worktree of this repository uses: not as a
   * folder, not as a branch, not pinned by another workspace's metadata.
   */
  private async freeName(root: string, selfKey: string, binding: Binding, folder: string, cache: string, base: string): Promise<string> {
    const taken = new Set<string>();
    for (const file of await readdir(join(root, "bindings")).catch(() => [] as string[])) {
      if (!/^[a-f0-9]{64}\.json$/.test(file) || file === `${selfKey}.json`) continue;
      try {
        const other = JSON.parse(await readFile(join(root, "bindings", file), "utf8")) as Binding;
        if (other.cacheKey !== binding.cacheKey) continue;
        if (other.branch) taken.add(other.branch);
        for (const location of [other.location, other.previousLocation]) if (location) taken.add(location.relativePath.split("/")[1]);
      } catch { /* unreadable metadata: folders and branches below are still checked */ }
    }
    const hasCache = await exists(cache);
    for (let n = 1; n < 1000; n += 1) {
      const name = n === 1 ? base : `${base}-${n}`;
      if (taken.has(name) || await exists(join(folder, name))) continue;
      if (hasCache && await this.hasRef(cache, `refs/heads/${name}`)) continue;
      return name;
    }
    throw new Error("No free worktree name in this repository. Files were preserved.");
  }

  /**
   * Older worktrees had ID-suffixed folders and workspace/<key> branches; give
   * them the readable name new ones get. Called with the workspace and cache
   * locks held. The destination is pinned before anything moves, so an
   * interrupted rename finishes next time; uncommitted files travel with
   * `git worktree move`. Never fatal: on any problem the worktree keeps
   * working where it is, under its old names, and this is tried again later.
   */
  private async adoptReadableName(root: string, key: string, bindingPath: string, binding: Binding, cache: string): Promise<void> {
    if (!binding.location) return;
    const legacy = legacyBranch(key);
    const head = async (path: string) => (await this.git(path, ["symbolic-ref", "--quiet", "HEAD"]).catch(() => "")).trim();
    try {
      if (!binding.branch) {
        const [repositoryFolder, current] = binding.location.relativePath.split("/");
        const folder = resolve(binding.location.workspaceRoot, repositoryFolder);
        const readable = bindingName(binding);
        // Older folders end in --<id>. One without it was already allocated a
        // readable, unique name (a worktree moved from the very first layout).
        const name = current.includes("--") ? await this.freeName(root, key, binding, folder, cache, readable) : current;
        if (name !== current) {
          binding.previousLocation = binding.location;
          binding.location = { workspaceRoot: binding.location.workspaceRoot, relativePath: `${repositoryFolder}/${name}` };
        }
        binding.branch = name;
        await writeWorkspaceMetadata(bindingPath, binding);
      }
      const target = locationPath(binding.location);
      if (binding.previousLocation) {
        const from = locationPath(binding.previousLocation);
        if (await exists(from)) {
          if (await exists(target)) throw new Error(`Both ${from} and ${target} exist; neither was moved.`);
          await this.git({ bare: cache }, ["worktree", "move", from, target]);
        }
      }
      if (await exists(target)) {
        if (await head(target) === `refs/heads/${legacy}`) await this.git(target, ["branch", "-m", legacy, binding.branch!]);
      } else if (await this.hasRef(cache, `refs/heads/${legacy}`) && !await this.hasRef(cache, `refs/heads/${binding.branch}`)) {
        await this.git({ bare: cache }, ["branch", "-m", legacy, binding.branch!]);
      }
      if (binding.previousLocation) {
        delete binding.previousLocation;
        await writeWorkspaceMetadata(bindingPath, binding);
      }
    } catch (cause) {
      // Settle on what is actually on disk, so nothing is created twice.
      if (binding.previousLocation && await exists(locationPath(binding.previousLocation))) binding.location = binding.previousLocation;
      delete binding.previousLocation;
      const path = locationPath(binding.location);
      const current = (await exists(path)) ? await head(path) : "";
      if (current === `refs/heads/${legacy}`) delete binding.branch;
      else if (current.startsWith("refs/heads/")) binding.branch = current.slice("refs/heads/".length);
      await writeWorkspaceMetadata(bindingPath, binding).catch(() => {});
      console.error(`[runner] worktree keeps its current name for now: ${String(cause)}`);
    }
  }

  /** Readable names for an idle worktree before a terminal opens there; skipped while it is busy. */
  private async tidyIdle(root: string, key: string, bindingPath: string, binding: Binding): Promise<Binding> {
    if (binding.branch && !binding.previousLocation) return binding;
    const lockPath = join(root, "locks", `workspace-${key}`);
    if (this.activeWorkspaces.has(lockPath) || this.idleCaptures.has(lockPath)) return binding;
    const cache = join(root, "repos", `${binding.cacheKey}.git`);
    try {
      return await withWorkspaceLock(lockPath, randomUUID(), () => withWorkspaceLock(join(root, "locks", `cache-${binding.cacheKey}`), randomUUID(), async () => {
        const current = JSON.parse(await readFile(bindingPath, "utf8")) as Binding;
        if (await exists(cache)) await this.adoptReadableName(root, key, bindingPath, current, cache);
        return current;
      }, 10_000));
    } catch { return binding; } // busy: rename on a later turn
  }

  /** Poll saved workspaces between jobs too, so manual edits can synchronize. */
  async checkpointIdleWorkspaces() {
    const roots = await readdir(join(this.dataDir, "workspaces-v1"), { withFileTypes: true }).catch(() => []);
    for (const scope of roots) {
      if (!scope.isDirectory() || !/^[a-f0-9]{64}$/.test(scope.name)) continue;
      const root = join(this.dataDir, "workspaces-v1", scope.name);
      for (const file of await readdir(join(root, "bindings")).catch(() => [])) {
        if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
        // The binding file is named by its workspace key, which also names
        // the lock and branch (a room repository, or one parallel chat).
        const key = file.slice(0, -5);
        const bindingPath = join(root, "bindings", file);
        const binding: Binding = JSON.parse(await readFile(bindingPath, "utf8"));
        // Scope binds the server and account; the stored job was captured by this runner.
        if (!binding.location || !binding.checkpointJob || binding.checkpointOwner !== digest(`${this.server}\0${this.token}`)) continue;
        const work = locationPath(binding.location), cache = join(root, "repos", `${binding.cacheKey}.git`);
        const lockPath = join(root, "locks", `workspace-${key}`);
        // A job of this process owns it (or is about to): its own checkpoints cover it.
        if (this.activeWorkspaces.has(lockPath) || this.idleCaptures.has(lockPath)) continue;
        const capture = (async () => {
          try {
            await withWorkspaceLock(lockPath, binding.checkpointJob!.turnId, () =>
              withWorkspaceLock(join(root, "locks", `cache-${binding.cacheKey}`), binding.checkpointJob!.turnId, async () => {
                const current: Binding = JSON.parse(await readFile(bindingPath, "utf8"));
                if (current.checkpointOwner !== digest(`${this.server}\0${this.token}`) || current.repoRef !== binding.repoRef || current.cacheKey !== binding.cacheKey || !current.location || locationPath(current.location) !== work) return;
                await this.capture(bindingPath, current, work, cache, branchOf(current, key));
              }, 125_000));
          } catch (cause) { console.error(`[runner] checkpoint pending: ${String(cause)}`); }
        })();
        this.idleCaptures.set(lockPath, capture);
        try { await capture; } finally { this.idleCaptures.delete(lockPath); }
      }
    }
  }

  async deliverCheckpoints(api: RunnerApi) {
    const directory = this.checkpointDirectory();
    for (const file of await readdir(directory).catch(() => [])) {
      if (!/^[a-f0-9-]{36}\.json$/.test(file)) continue;
      try {
        const entry = JSON.parse(await readFile(join(directory, file), "utf8")) as { snapshot: Checkpoint; repoRef: string; cache: string };
        const { snapshot, cache, repoRef } = entry;
        const ref = checkpointRef(snapshot);
        // A lost HTTP response after push is safe to retry without updating the immutable ref.
        const remote = (await this.git({ bare: cache }, ["ls-remote", this.remoteUrl(repoRef), ref], snapshot.turnId)).trim().split(/\s+/)[0];
        if (remote && remote !== snapshot.snapshotSha) throw new Error("Remote checkpoint sequence has different content.");
        if (!remote) await this.git({ bare: cache }, ["push", this.remoteUrl(repoRef), `${snapshot.snapshotSha}:${ref}`], snapshot.turnId, snapshot.sequence);
        await api.checkpoint(snapshot);
        await unlink(join(directory, file));
      } catch (cause) { console.error(`[runner] checkpoint retained for retry: ${String(cause)}`); }
    }
  }

  private async checkWorktree(work: string, cache: string, branch: string): Promise<void> {
    const info = await lstat(work);
    if (info.isSymbolicLink() || !info.isDirectory() || !(await lstat(join(work, ".git"))).isFile() ||
        await realpath((await this.git(work, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim()) !== await realpath(cache)) {
      throw new Error(`Workspace does not belong to its repository cache: ${work}. Files were preserved.`);
    }
    await this.checkBranch(work, branch);
  }

  private async hasRef(cache: string, ref: string): Promise<boolean> {
    return Boolean((await this.git({ bare: cache }, ["for-each-ref", "--format=%(refname)", ref])).trim());
  }

  private async checkBranch(work: string, branch: string): Promise<void> {
    if ((await this.git(work, ["symbolic-ref", "--quiet", "HEAD"])).trim() !== `refs/heads/${branch}`) {
      throw new Error(`Workspace branch changed: ${work}. Restore its workspace branch before continuing; files were preserved.`);
    }
  }
}
