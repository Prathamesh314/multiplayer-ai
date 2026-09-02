import type { PtyControl, TerminalStatus } from "./protocol";

export async function fetchTerminalStatus(): Promise<TerminalStatus> {
  const response = await fetch("/api/terminal", { cache: "no-store" });
  if (!response.ok) throw new Error(`Terminal status failed (${response.status})`);
  return (await response.json()) as TerminalStatus;
}

/** Fire-and-forget control message to a shell (keystrokes, resize, kill). */
async function control(body: PtyControl, keepalive = false): Promise<void> {
  try {
    await fetch("/api/terminal/pty", {
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
