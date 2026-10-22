/**
 * Client half of presence: one heartbeat per open tab, for as long as the tab
 * is open. Nothing here is authoritative — the server decides both the cadence
 * and who is actually online.
 */

export type HeartbeatOptions = {
  sessionId?: string | null;
  orgId?: string | null;
  /** The chat this tab has open; change it later with `setRun`. */
  runId?: string | null;
  /** Called with the user ids currently in the same session. */
  onOnline?: (userIds: string[]) => void;
  /** Called with the user ids that have the same chat open. */
  onViewers?: (userIds: string[]) => void;
  /** Called after every successful beat (e.g. to refresh an org's online list). */
  onBeat?: () => void;
};

/** Stable per tab: two tabs must look like two connections, not one. */
function newConnectionId(): string {
  return crypto.randomUUID();
}

export type HeartbeatHandle = {
  stop: () => void;
  /** Report a different open chat (or none) right away. */
  setRun: (runId: string | null) => void;
  /** Beat now, e.g. when someone else in the room opened a chat. */
  beatNow: () => void;
};

export function startHeartbeat(options: HeartbeatOptions): HeartbeatHandle {
  const connectionId = newConnectionId();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let runId = options.runId ?? null;
  let inFlight = false;
  let again = false;

  function schedule(ms: number) {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(beat, ms);
  }

  async function beat() {
    if (stopped) return;
    // One request at a time; a beat asked for meanwhile follows straight after.
    if (inFlight) { again = true; return; }
    inFlight = true;
    try {
      const response = await fetch("/api/presence", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          connectionId,
          sessionId: options.sessionId ?? null,
          orgId: options.orgId ?? null,
          runId,
        }),
      });

      if (response.ok) {
        const body = (await response.json()) as { intervalMs: number; online: string[]; viewers?: string[] };
        options.onOnline?.(body.online);
        options.onViewers?.(body.viewers ?? []);
        options.onBeat?.();
        // The server owns the cadence, so changing it needs no client release.
        schedule(body.intervalMs);
        return;
      }
    } catch {
      // Offline or the server restarted. Presence expires by itself, so the
      // only thing to do is keep trying.
    } finally {
      inFlight = false;
      if (again && !stopped) { again = false; void beat(); }
    }
    schedule(20_000);
  }

  void beat();

  // Leaving the page says goodbye at once; sendBeacon survives the page going
  // away, which a fetch does not (and it can only POST).
  const onPageHide = () => {
    navigator.sendBeacon?.(`/api/presence?connectionId=${encodeURIComponent(connectionId)}&leave=1`);
  };
  // Back from the background or a sleeping laptop: be counted again now.
  const onVisible = () => { if (document.visibilityState === "visible") void beat(); };
  window.addEventListener("pagehide", onPageHide);
  document.addEventListener("visibilitychange", onVisible);

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("visibilitychange", onVisible);
      void fetch(`/api/presence?connectionId=${encodeURIComponent(connectionId)}`, {
        method: "DELETE",
        keepalive: true,
      }).catch(() => {});
    },
    setRun(next) {
      if (next === runId) return;
      runId = next;
      void beat();
    },
    beatNow() {
      void beat();
    },
  };
}
