import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { dataRoot } from "./paths";

export interface RepoLock {
  withLock<T>(id: string, task: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
type HeldLock = { fd: number; active: boolean };
const globalLocks = globalThis as unknown as {
  __maFileLocks?: AsyncLocalStorage<Map<string, HeldLock>>;
  __maRepoLock?: Promise<RepoLock>;
};
const held = globalLocks.__maFileLocks ??= new AsyncLocalStorage<Map<string, HeldLock>>();

/** Git children inherit the kernel locks, including when the parent is killed.
 * An escaped asynchronous callback must never reuse closed/reassigned fds. */
export function inheritedRepoLocks(): number[] {
  const locks = [...(held.getStore()?.values() ?? [])];
  if (locks.some(lock => !lock.active)) throw new Error("Repository operation outlived its lock.");
  return locks.map(lock => lock.fd);
}

/** Start a genuinely independent background operation with its own locks. */
export function outsideRepoLocks<T>(task: () => T): T {
  return held.run(new Map(), task);
}

export function createMemoryLock(): RepoLock {
  const chains = new Map<string, Promise<unknown>>();
  return {
    async withLock(id, task) {
      const result = (chains.get(id) ?? Promise.resolve()).then(task, task);
      const settled = result.then(() => undefined, () => undefined);
      chains.set(id, settled);
      try { return await result; }
      finally { if (chains.get(id) === settled) chains.delete(id); }
    },
    async close() {},
  };
}

// flock belongs to the open file description shared with the parent, not the
// helper's PID. Python is already installed in the production web/worker images.
// No lease expiry, stale-file deletion, Redis dependency, or native Node addon.
const ACQUIRE = `import errno,fcntl,sys,time
deadline=time.monotonic()+float(sys.argv[1])
while True:
 try:
  fcntl.flock(3,fcntl.LOCK_EX|fcntl.LOCK_NB)
  break
 except OSError as error:
  if error.errno not in (errno.EACCES,errno.EAGAIN): raise
  if time.monotonic()>=deadline: sys.exit(75)
  time.sleep(0.025)
`;
export function createFileLock(options: { directory?: string; acquireTimeoutMs?: number; python?: string } = {}): RepoLock {
  const acquireTimeoutMs = options.acquireTimeoutMs ?? 60_000;
  if (!Number.isFinite(acquireTimeoutMs) || acquireTimeoutMs < 1) throw new Error("Invalid repository lock timeout.");
  return {
    async withLock(id, task) {
      if (process.platform === "win32") throw new Error("The repository server requires Linux/macOS file locking. Run the server in Docker; Windows desktop runners are supported.");
      const directory = resolve(options.directory ?? join(dataRoot(), "repo-locks"));
      const path = join(directory, createHash("sha256").update(id).digest("hex") + ".lock");
      inheritedRepoLocks();
      if (held.getStore()?.get(path)?.active) return task();
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const handle = await open(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
      const state: HeldLock = { fd: handle.fd, active: false };
      try {
        await new Promise<void>((resolveAcquire, reject) => {
          const child = spawn(options.python ?? process.env.REPO_LOCK_PYTHON ?? "python3", ["-c", ACQUIRE, String(acquireTimeoutMs / 1000)], {
            stdio: ["ignore", "ignore", "pipe", handle.fd], windowsHide: true,
          });
          let error = "";
          child.stderr!.on("data", chunk => { error = (error + chunk).slice(-2048); });
          const deadline = setTimeout(() => child.kill("SIGKILL"), acquireTimeoutMs + 5000);
          child.once("error", cause => { clearTimeout(deadline); reject(cause); });
          child.once("close", code => {
            clearTimeout(deadline);
            if (code === 0) resolveAcquire();
            else reject(new Error(code === 75 ? "Repository is busy. Try again shortly." : `Repository file lock unavailable: ${error || code}`));
          });
        });
        state.active = true;
        return await held.run(new Map([...(held.getStore() ?? []), [path, state]]), task);
      } finally {
        state.active = false;
        // Never unlink or LOCK_UN: Git children may still hold this description.
        // The kernel releases it only after the last inherited fd is closed.
        await handle.close();
      }
    },
    async close() {},
  };
}

/** All writers share a local filesystem on the single repository-owning host.
 * NFS/multi-host storage is intentionally unsupported. Fail closed if locking
 * is unavailable. All replicas must be stopped when upgrading the old driver. */
export function repoLock(): Promise<RepoLock> {
  return globalLocks.__maRepoLock ??= Promise.resolve(createFileLock());
}
