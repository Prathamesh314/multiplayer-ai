/**
 * Client half of presence: one heartbeat per open tab, for as long as the tab
 * is open. Nothing here is authoritative — the server decides both the cadence
 * and who is actually online.
 */

export type HeartbeatOptions = {
  sessionId?: string | null;
  orgId?: string | null;
  /** Called with the user ids currently in the same session. */
  onOnline?: (userIds: string[]) => void;
};

/** Stable per tab: two tabs must look like two connections, not one. */
function newConnectionId(): string {
  return crypto.randomUUID();
}

export type HeartbeatHandle = { stop: () => void };

export function startHeartbeat(options: HeartbeatOptions): HeartbeatHandle {
  const connectionId = newConnectionId();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  async function beat() {
    if (stopped) return;
    try {
      const response = await fetch("/api/presence", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          connectionId,
          sessionId: options.sessionId ?? null,
          orgId: options.orgId ?? null,
        }),
      });

      if (response.ok) {
        const body = (await response.json()) as { intervalMs: number; online: string[] };
        options.onOnline?.(body.online);
        // The server owns the cadence, so changing it needs no client release.
        if (!stopped) timer = setTimeout(beat, body.intervalMs);
        return;
      }
    } catch {
      // Offline or the server restarted. Presence expires by itself, so the
      // only thing to do is keep trying.
    }
    if (!stopped) timer = setTimeout(beat, 20_000);
  }

  void beat();

  const onHide = () => {
    if (document.visibilityState !== "hidden") return;
    // sendBeacon survives the page going away, which a fetch does not.
    navigator.sendBeacon?.(`/api/presence?connectionId=${encodeURIComponent(connectionId)}`);
  };
  document.addEventListener("visibilitychange", onHide);

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onHide);
      void fetch(`/api/presence?connectionId=${encodeURIComponent(connectionId)}`, {
        method: "DELETE",
        keepalive: true,
      }).catch(() => {});
    },
  };
}
