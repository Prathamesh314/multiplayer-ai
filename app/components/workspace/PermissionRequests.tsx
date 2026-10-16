"use client";
import { useEffect, useState } from "react";
import { openSessionStream } from "../../lib/events/client";
import type { PermissionDecision, PermissionRequest } from "../../lib/ai/permissions";

/**
 * Tool requests an agent is waiting on (a web fetch, an MCP connector, a shell
 * command). Only the chat's driver answers: the agent runs on their computer,
 * with their AI account. Everyone else sees that it is waiting.
 */
export function PermissionRequests({ sessionId, runId, canAnswer, driverName, agentName }: {
  sessionId: string; runId: string; canAnswer: boolean; driverName: string | null; agentName: string;
}) {
  const [requests, setRequests] = useState<PermissionRequest[]>([]);
  const [busy, setBusy] = useState<string | null>(null), [error, setError] = useState("");
  const endpoint = `/api/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/permissions`;
  useEffect(() => {
    const controller = new AbortController();
    let loading = false, dirty = false;
    const refresh = async () => {
      if (loading) { dirty = true; return; }
      loading = true;
      do {
        dirty = false;
        try {
          const response = await fetch(endpoint, { cache: "no-store", signal: controller.signal });
          if (response.ok && !controller.signal.aborted) setRequests((await response.json()).requests);
        } catch { /* the next event or reconnect refreshes */ }
      } while (dirty && !controller.signal.aborted);
      loading = false;
    };
    const stream = openSessionStream(sessionId, {
      onRunPermission: (event) => { if (event.runId === runId) void refresh(); },
      onRunFinished: (event) => { if (event.runId === runId) void refresh(); },
      onStatus: (connected) => { if (connected) void refresh(); },
    });
    return () => { controller.abort(); stream.close(); };
  }, [endpoint, sessionId, runId]);

  async function answer(request: PermissionRequest, decision: PermissionDecision) {
    if (busy) return;
    setBusy(request.id); setError("");
    try {
      const response = await fetch(`${endpoint}/${encodeURIComponent(request.id)}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Could not send your answer.");
      setRequests((list) => list.map((item) => (item.id === request.id
        ? { ...item, status: decision === "deny" ? "denied" : "allowed", remember: decision === "always" } : item)));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not send your answer.");
    } finally { setBusy(null); }
  }

  const pending = requests.filter((request) => request.status === "pending");
  if (!pending.length) return null;
  return (
    <section aria-label="Tool requests" className="mx-auto w-full max-w-4xl space-y-2 border-t border-vs-border px-4 py-3">
      {pending.map((request) => (
        <div key={request.id} role="alert" className="rounded-xl border border-vs-accent/50 bg-vs-panel p-3 text-xs">
          <p className="text-vs-muted">{agentName} wants to</p>
          <p className="mt-0.5 break-words font-medium text-vs-fg">{request.title}</p>
          {request.detail && (
            <details className="mt-1.5">
              <summary className="cursor-pointer text-vs-muted">Details</summary>
              <pre className="vs-scroll mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-vs-editor p-2 text-[11px]">{request.detail}</pre>
            </details>
          )}
          {canAnswer ? (
            <div className="mt-2.5 flex flex-wrap gap-2">
              <button type="button" disabled={!!busy} onClick={() => void answer(request, "allow")} className="rounded-lg bg-vs-accent px-3 py-1.5 font-medium text-vs-accent-fg disabled:opacity-50">Allow once</button>
              {request.rule && (
                <button type="button" disabled={!!busy} onClick={() => void answer(request, "always")} title={`Remember ${request.rule} for this chat`} className="rounded-lg border border-vs-border px-3 py-1.5 text-vs-fg hover:bg-vs-hover disabled:opacity-50">Always allow in this chat</button>
              )}
              <button type="button" disabled={!!busy} onClick={() => void answer(request, "deny")} className="rounded-lg border border-vs-border px-3 py-1.5 text-vs-fg hover:bg-vs-hover disabled:opacity-50">Deny</button>
            </div>
          ) : (
            <p className="mt-2 text-vs-muted">Waiting for {driverName ?? "the person running this chat"} to allow it. It runs on their computer.</p>
          )}
        </div>
      ))}
      {error && <p role="alert" className="text-xs text-vs-danger">{error}</p>}
    </section>
  );
}
