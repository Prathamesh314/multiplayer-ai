/*
 * The runner's git layer: a local checkout per repo, fed over the control
 * plane's smart-HTTP endpoint with the device token.
 *
 * Mirrors the server's own conventions exactly (app/lib/session/repo.ts):
 * work happens on `session/<repoRef>`, materialize = clone + hard reset to
 * the job's base, and a finished run is one commit pushed back to that same
 * branch. The push is not best-effort here — for a remote runner the push
 * *is* delivery, and /complete verifies the commit landed, so a failed push
 * fails the run loudly instead of stranding work on a laptop.
 */

import { execFile } from "node:child_process";
import { mkdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const CONFIG = [
  "-c", "commit.gpgsign=false",
  "-c", "core.autocrlf=false",
];

const GIT_ENV = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};

export class RunnerGit {
  constructor(
    private readonly server: string,
    private readonly token: string,
    private readonly dataDir: string,
  ) {}

  private turnId: string | null = null;

  private get authArgs(): string[] {
    return ["-c", `http.extraHeader=Authorization: Bearer ${this.token}`, ...(this.turnId ? ["-c", `http.extraHeader=X-Turn-Id: ${this.turnId}`] : [])];
  }

  private async git(cwd: string, args: string[], withAuth = false): Promise<string> {
    const { stdout } = await run(
      "git",
      [...CONFIG, ...(withAuth ? this.authArgs : []), ...args],
      { cwd, env: { ...process.env, ...GIT_ENV }, timeout: 120_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
    );
    return stdout;
  }

  workPath(repoRef: string): string {
    return join(this.dataDir, "work", this.turnId ?? repoRef);
  }

  private remoteUrl(repoRef: string): string {
    return `${this.server}/api/git/${encodeURIComponent(repoRef)}`;
  }

  /** Materialize the repo at the run's base: clone once, then fetch + reset. */
  async ensureWork(repoRef: string, baseSha: string, turnId: string): Promise<string> {
    this.turnId = turnId;
    const work = this.workPath(repoRef);
    const branch = `session/${repoRef}`;

    const isRepo = await stat(join(work, ".git"))
      .then((entry) => entry.isDirectory())
      .catch(() => false);

    if (!isRepo) {
      await rm(work, { recursive: true, force: true });
      await mkdir(dirname(work), { recursive: true });
      await this.git(dirname(work), ["clone", "--branch", branch, this.remoteUrl(repoRef), work], true);
    } else {
      await this.git(work, ["fetch", "origin", branch], true);
    }
    await this.git(work, ["reset", "--hard", baseSha]);
    await this.git(work, ["clean", "-fd"]);
    return work;
  }

  /**
   * Commit whatever the agent changed and deliver it. Returns the pushed
   * commit, or null when the run changed nothing. Throws when the push is
   * refused — the server would reject the completion report anyway.
   */
  async commitAndPush(
    repoRef: string,
    message: string,
    author: { name: string; email: string },
    turnId: string,
    baseSha: string,
  ): Promise<string | null> {
    const work = this.workPath(repoRef);
    await this.git(work, ["add", "-A"]);
    const status = (await this.git(work, ["status", "--porcelain"])).trim();
    if (status.length > 0) await this.git(work, [
      "-c", `user.name=${author.name}`,
      "-c", `user.email=${author.email}`,
      "commit", "-m", message,
    ]);
    const sha = (await this.git(work, ["rev-parse", "HEAD"])).trim();
    if (sha === baseSha) return null;
    await this.git(work, ["push", "origin", `HEAD:refs/turns/${turnId}`], true);
    return sha;
  }
}
