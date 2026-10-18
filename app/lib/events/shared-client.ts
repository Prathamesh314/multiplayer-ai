/** One physical EventSource per URL per tab, regardless of component count. */
type Listener = { event: (type: string, data: unknown) => void; status?: (ready: boolean) => void };
const streams = new Map<string, { source: EventSource; listeners: Set<Listener>; ready: boolean }>();
const names = ["file.saved", "file.editing", "message.created", "members.changed", "role.changed", "run.control",
  "run.started", "run.output", "run.turn", "run.finished", "run.branch", "run.inputs", "run.activity", "run.permission", "repos.changed", "devices.changed", "tasks.changed", "usage.changed", "resync"];

export function sharedStream(url: string, listener: Listener): { close(): void } {
  let entry = streams.get(url);
  if (!entry) {
    const source = new EventSource(url);
    entry = { source, listeners: new Set(), ready: false };
    streams.set(url, entry);
    const current = entry;
    const status = (ready: boolean) => {
      if (ready === current.ready) return;
      current.ready = ready;
      for (const item of [...current.listeners]) item.status?.(ready);
    };
    // ready is emitted after subscriptions are installed. Native open is too
    // early: a refresh there can race a change before subscription completes.
    source.addEventListener("ready", () => status(true));
    source.onerror = () => status(false);
    for (const name of names) source.addEventListener(name, message => {
      let data: unknown;
      try { data = JSON.parse((message as MessageEvent).data); } catch { return; }
      for (const item of [...current.listeners]) {
        try { if (name === "resync") item.status?.(true); else item.event(name, data); } catch { /* isolate readers */ }
      }
    });
  }
  entry.listeners.add(listener);
  const current = entry;
  let closed = false;
  if (current.ready) queueMicrotask(() => { if (!closed) listener.status?.(true); });
  return { close() {
    if (closed) return;
    closed = true;
    current.listeners.delete(listener);
    if (!current.listeners.size) { current.source.close(); streams.delete(url); }
  } };
}

export function openUserStream(onChange: (type: string) => void, onReady?: () => void) {
  return sharedStream("/api/events", { event: type => onChange(type), status: ready => { if (ready) onReady?.(); } });
}
