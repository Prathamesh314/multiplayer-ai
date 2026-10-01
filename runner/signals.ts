/** A remembered wakeup: a notification between a check and wait is not lost. */
export class WakeSignal {
  private revision = 0;
  private listeners = new Set<() => void>();
  version() { return this.revision; }
  wake() { this.revision++; for (const listener of [...this.listeners]) listener(); }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  wait(version: number, signal?: AbortSignal): Promise<void> {
    if (this.revision !== version || signal?.aborted) return Promise.resolve();
    return new Promise(resolve => {
      const done = () => { this.listeners.delete(done); signal?.removeEventListener("abort", done); resolve(); };
      this.listeners.add(done);
      signal?.addEventListener("abort", done, { once: true });
      if (this.revision !== version || signal?.aborted) done();
    });
  }
}

/** Read server signals without buffering activity or losing split SSE frames. */
export async function readSignals(response: Response, onEvent: (type: string, data: unknown) => void) {
  if (!response.body) throw new Error("Runner live connection has no body.");
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const read = reader.read();
      const { done, value } = await Promise.race([read, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Runner live connection stopped sending keepalives.")), 45_000);
      })]).finally(() => clearTimeout(timer));
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > 256 * 1024) throw new Error("Runner event exceeds the size limit.");
      let end: number;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const type = frame.split("\n").find(line => line.startsWith("event:"))?.slice(6).trim();
        const data = frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
        if (type) { let parsed: unknown; try { parsed = JSON.parse(data || "{}"); } catch { continue; } onEvent(type, parsed); }
      }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
