"use client";
import { useEffect, useRef, useState } from "react";
import { openSessionStream } from "../../lib/events/client";
import type { ChatInput } from "../../lib/ai/input-queue";
import { SendIcon } from "../icons";

/**
 * The agent's working state where the composer sits: one card, shaped like the
 * composer, with a quiet shimmering status and elapsed time instead of a
 * separate bar. `onDetach` stops following the run in this tab only.
 */
export function WorkingStatus({ agentName, since, onDetach, children }: {
  agentName: string; since: number | null; onDetach?: () => void; children?: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-vs-border bg-vs-panel px-4 py-3 shadow-sm focus-within:border-vs-accent">
      <div className="flex min-w-0 items-center gap-2 text-[12.5px]" role="status">
        <span className="pulse-dot h-1.5 w-1.5 shrink-0 rounded-full bg-vs-accent" />
        <span className="shimmer-text truncate font-medium">{agentName} is working</span>
        {since && <Elapsed since={since} />}
        {onDetach && (
          <button type="button" onClick={onDetach} title="Stop following here. The agent keeps working on your computer, and the chat shows its result."
            className="ml-auto shrink-0 rounded-md px-2 py-0.5 text-[12px] text-vs-muted transition hover:bg-vs-hover hover:text-vs-fg">
            Detach
          </button>
        )}
      </div>
      {children}
    </div>
  );
}

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);
  const seconds = Math.max(0, Math.round((now - since) / 1000));
  return <span className="shrink-0 tabular-nums text-[11.5px] text-vs-muted/80">{seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`}</span>;
}

export function QueuedMessages({ sessionId, runId, version, active, canSend, agentId, agentName, startedAt, workingSince = null, onDetach, moveDraft }: {
  sessionId: string; runId: string; version: number; active: boolean; canSend: boolean; agentId: string; agentName: string; startedAt: number | null;
  /** When the current turn started, for its elapsed time; unknown for a watcher. */
  workingSince?: number | null;
  /** Set while this tab follows the run's live stream. */
  onDetach?: () => void;
  moveDraft(text: string): void;
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
  const label = (status: ChatInput["status"]) => status === "queued" ? "Queued" : status === "delivering" ? "Sending…" : status === "failed" ? "Not delivered" : "Delivery unconfirmed";
  return <div className="mx-auto w-full max-w-4xl space-y-2 px-3 pb-3 pt-2" aria-label="Chat message queue">
    {!!visible.length && <ul className="vs-scroll max-h-40 space-y-1.5 overflow-auto">{visible.map(item => <li key={item.id} className="flex items-start gap-2.5 rounded-xl border border-vs-border bg-vs-panel/60 px-3 py-2 text-[13px]">
      <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${["failed", "unconfirmed"].includes(item.status) ? "bg-vs-warn" : "bg-vs-muted/60"}`} />
      <div className="min-w-0 flex-1">
        <p className="whitespace-pre-wrap break-words text-vs-fg">{item.body}</p>
        <p className="mt-0.5 text-[11px] text-vs-muted">{label(item.status)}{item.error ? ` · ${item.error}` : ""}</p>
      </div>
      {canSend && item.status === "queued" && <button className="shrink-0 text-[12px] text-vs-muted hover:text-vs-fg" onClick={() => void remove(item.id)}>Remove</button>}
      {canSend && !active && ["failed", "unconfirmed"].includes(item.status) && <button className="shrink-0 text-[12px] text-vs-accent" onClick={() => moveDraft(item.body)}>Copy to message</button>}
    </li>)}</ul>}
    {!!delivered && <p className="px-1 text-[11.5px] text-vs-muted">{delivered} queued {delivered === 1 ? "message" : "messages"} accepted by the agent</p>}
    {active && <WorkingStatus agentName={agentName} since={workingSince} onDetach={onDetach}>
      {canSend && <form onSubmit={event => { event.preventDefault(); void send(); }} className="mt-2.5">
        <div className="flex items-end gap-3">
          <textarea aria-label="Message working agent" placeholder="Queue a follow-up…" value={draft} maxLength={32000} readOnly={busy} rows={2}
            onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }}
            className="vs-scroll max-h-40 min-h-10 flex-1 resize-none bg-transparent text-[13px] text-vs-fg outline-none placeholder:text-vs-muted" />
          <button type="submit" disabled={busy || !draft.trim()} title="Queue message"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-vs-accent text-vs-accent-fg transition hover:opacity-90 disabled:opacity-30">
            <SendIcon className="h-3.5 w-3.5" /><span className="sr-only">Queue message</span>
          </button>
        </div>
        <p className="mt-1.5 text-[11px] text-vs-muted">{agentId === "codex" ? "Codex takes it during this turn." : "Sent once this response finishes."} Enter to queue · Shift+Enter for a new line</p>
      </form>}
    </WorkingStatus>}
    {!active && draft && <div className="rounded-xl border border-vs-border px-3 py-2 text-[13px]"><p className="text-vs-muted">Your unsent instruction is preserved.</p><button className="text-vs-accent" onClick={() => { moveDraft(draft); setDraft(""); }}>Move draft to message</button></div>}
    {error && <p role="alert" className="px-1 text-sm text-vs-danger">{error}</p>}
  </div>;
}
