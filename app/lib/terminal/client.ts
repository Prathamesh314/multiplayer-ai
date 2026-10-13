import type { PtyControl, TerminalStatus } from "./protocol";

export async function fetchTerminalStatus(): Promise<TerminalStatus> {
  const response = await fetch("/api/terminal", { cache: "no-store" });
  if (!response.ok) throw new Error(`Terminal status failed (${response.status})`);
  return (await response.json()) as TerminalStatus;
}

/**
 * Fire-and-forget control message to a shell (keystrokes, resize, kill).
 *
 * The id is repeated in the query string even though the server reads it from
 * the body: a shell lives in one web process's memory, so a multi-replica
 * deployment has to send every message about a given id to the same upstream,
 * and a load balancer can only see the URL (see the Caddyfile's `lb_policy
 * query id` for /api/terminal/*).
 */
async function control(body: PtyControl, keepalive = false): Promise<void> {
  try {
    await fetch(`/api/terminal/pty?id=${encodeURIComponent(body.id)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      keepalive,
    });
  } catch {
    // A dropped keystroke is not worth surfacing; the stream will recover.
  }
}

export function postPtyInput(id: string, data: string): void {
  void control({ id, type: "input", data });
}

export function postPtyResize(id: string, cols: number, rows: number): void {
  void control({ id, type: "resize", cols, rows });
}

/** keepalive so the kill still lands when the tab/page is closing. */
export function killPty(id: string): void {
  void control({ id, type: "kill" }, true);
}
