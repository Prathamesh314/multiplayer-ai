import type { ChildProcess } from "node:child_process";

/**
 * Live child processes, keyed by the run id the client generated, so a separate
 * request can interrupt them.
 */
const running = new Map<string, ChildProcess>();

export function register(runId: string, child: ChildProcess): void {
  running.set(runId, child);
}

export function unregister(runId: string): void {
  running.delete(runId);
}

/** Interrupts a run, escalating to SIGKILL if it ignores SIGINT. */
export function interrupt(runId: string): boolean {
  const child = running.get(runId);
  if (!child?.pid) return false;

  signal(child, "SIGINT");
  const escalate = setTimeout(() => {
    if (running.has(runId)) signal(child, "SIGKILL");
  }, 2000);
  escalate.unref?.();

  return true;
}

/**
 * Children are spawned detached, so the negative pid targets the whole process
 * group — otherwise a shell would die and leave its children behind.
 */
function signal(child: ChildProcess, name: NodeJS.Signals): void {
  try {
    process.kill(-child.pid!, name);
  } catch {
    try {
      child.kill(name);
    } catch {
      // Already gone.
    }
  }
}
