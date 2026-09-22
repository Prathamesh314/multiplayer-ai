import { mkdir, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/** Never steal a lock by age/PID: a crashed runner can leave a live agent child. */
export async function withWorkspaceLock<T>(path: string, turnId: string, task: () => Promise<T>, waitMs = 0): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      await mkdir(path, { mode: 0o700 });
      break;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
      if (Date.now() >= deadline) {
        throw new Error(`Workspace is in use by another runner, or needs recovery after an interruption. Lock: ${path}. Stop its runner and agent processes before removing a stale lock; your files have been preserved.`);
      }
      await delay(100);
    }
  }
  try {
    await writeFile(join(path, "owner.json"), JSON.stringify({ pid: process.pid, turnId, startedAt: new Date().toISOString() }), { mode: 0o600 });
    return await task();
  } finally {
    await unlink(join(path, "owner.json")).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code !== "ENOENT") throw cause;
    });
    await rmdir(path);
  }
}
