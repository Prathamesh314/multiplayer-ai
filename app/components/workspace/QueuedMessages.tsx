"use client";
import { useEffect, useRef, useState } from "react";
import { openSessionStream } from "../../lib/events/client";
import type { ChatInput } from "../../lib/ai/input-queue";

export function QueuedMessages({ sessionId, runId, version, active, canSend, agentId, startedAt, moveDraft }: {
  sessionId: string; runId: string; version: number; active: boolean; canSend: boolean; agentId: string; startedAt: number | null; moveDraft(text: string): void;
}) {
  const [entries, setEntries] = useState<ChatInput[]>([]), [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const request = useRef<{ body: string; id: string } | null>(null);
  const endpoint = `/api/sessions/${sessionId}/runs/${runId}/inputs`;
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
          if (!response.ok) throw new Error("Could not refresh queued messages.");
          const body = await response.json();
          if (!controller.signal.aborted) setEntries(body.inputs);
        } catch (cause) { if (!controller.signal.aborted) setError(String(cause)); }
      } while (dirty && !controller.signal.aborted);
      loading = false;
    };
    const stream = openSessionStream(sessionId, {
      onRunControl: () => void refresh(),
      onRunInputs: event => { if (event.runId === runId) void refresh(); },
      onRunFinished: event => { if (event.runId === runId) void refresh(); },
      onStatus: connected => { if (connected) void refresh(); },
    });
    return () => { controller.abort(); stream.close(); };
  }, [endpoint, sessionId, runId]);
  async function send() {
    const body = draft.trim();
    if (busy || !body || !active || !canSend) return;
    if (request.current?.body !== body) request.current = { body, id: crypto.randomUUID() };
    setBusy(true); setError("");
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...request.current, controlVersion: version }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Message was not queued.");
      setEntries(previous => previous.some(item => item.id === result.input.id) ? previous : [...previous, result.input]);
      setDraft(""); request.current = null;
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  async function remove(id: string) {
    try {
      const response = await fetch(endpoint, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) });
      if (!response.ok) throw new Error((await response.json()).error);
      setEntries(previous => previous.filter(item => item.id !== id));
    } catch (cause) { setError(String(cause)); }
  }
  const visible = entries.filter(item => ["queued", "delivering", "failed", "unconfirmed"].includes(item.status));
  const delivered = active ? entries.filter(item => item.status === "delivered" && (!startedAt || new Date(item.createdAt).getTime() >= startedAt)).length : 0;
  if (!active && !draft && !visible.length && !error) return null;
  return <div className="mx-auto w-full max-w-4xl space-y-2 px-3 py-2" aria-label="Chat message queue">
    {!!visible.length && <ul className="max-h-40 space-y-2 overflow-auto text-sm">{visible.map(item => <li key={item.id} className="rounded-lg border border-vs-border bg-vs-panel px-3 py-2">
      <div className="flex items-center gap-2 text-xs text-vs-muted"><span>{item.status === "queued" ? "Queued" : item.status === "delivering" ? "Sending to agent…" : item.status === "failed" ? "Not delivered" : "Delivery unconfirmed"}</span>
        {canSend && item.status === "queued" && <button className="ml-auto hover:text-vs-fg" onClick={() => void remove(item.id)}>Remove</button>}
        {canSend && !active && ["failed", "unconfirmed"].includes(item.status) && <button className="ml-auto text-vs-accent" onClick={() => moveDraft(item.body)}>Copy to message</button>}
      </div><p className="mt-1 whitespace-pre-wrap break-words">{item.body}</p>{item.error && <p className="mt-1 text-xs text-vs-warn">{item.error}</p>}
    </li>)}</ul>}
    {!!delivered && <p className="text-xs text-vs-muted">{delivered} queued {delivered === 1 ? "message" : "messages"} accepted by the agent</p>}
    {active && canSend && <form onSubmit={event => { event.preventDefault(); void send(); }} className="rounded-xl border border-vs-border bg-vs-panel p-3 focus-within:border-vs-accent">
      <textarea aria-label="Message working agent" placeholder="Add an instruction while the agent works…" value={draft} maxLength={32000} readOnly={busy} rows={2}
        onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }}
        className="w-full resize-none bg-transparent text-sm text-vs-fg outline-none" />
      <div className="flex items-center justify-between gap-3"><p className="text-xs text-vs-muted">{agentId === "codex" ? "Added to the active turn when Codex accepts the instruction." : "Queued for the next response in this workspace."}</p>
        <button type="submit" disabled={busy || !draft.trim()} className="shrink-0 rounded-lg bg-vs-accent px-3 py-1.5 text-sm text-white disabled:opacity-40">{busy ? "Queuing…" : "Queue message"}</button></div>
    </form>}
    {!active && draft && <div className="text-sm"><p>Your unsent instruction is preserved.</p><button className="text-vs-accent" onClick={() => { moveDraft(draft); setDraft(""); }}>Move draft to message</button></div>}
    {error && <p role="alert" className="text-sm text-vs-danger">{error}</p>}
  </div>;
}
