"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { AgentRun } from "../../lib/ai/runs";
import type { HandoffAction, HandoffState } from "../../lib/ai/handoff";
import { openSessionStream } from "../../lib/events/client";
import { Modal } from "../ui/Modal";

type State = HandoffState & { run: AgentRun };
const button = "rounded-lg border border-vs-border px-3 py-1.5 text-xs font-medium transition hover:bg-vs-hover disabled:cursor-not-allowed disabled:opacity-50";

export function HandoffPanel({ run, userId, canEdit, isOwner, onUpdated, children }: {
  run: AgentRun;
  userId: string | null;
  canEdit: boolean;
  isOwner: boolean;
  onUpdated: (run: AgentRun) => void;
  children?: ReactNode;
}) {
  const [state, setState] = useState<State | null>(null);
  const [open, setOpen] = useState(false);
  const [recipient, setRecipient] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const updateRef = useRef(onUpdated);
  useEffect(() => { updateRef.current = onUpdated; }, [onUpdated]);
  const endpoint = `/api/sessions/${run.sessionId}/runs/${run.id}/handoff`;
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(endpoint, { cache: "no-store", signal });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? "Could not load handoff state.");
    if (signal?.aborted) return;
    setState(body);
    updateRef.current(body.run);
  }, [endpoint]);

  useEffect(() => {
    const controller = new AbortController();
    const reload = () => void refresh(controller.signal).catch(cause => {
      if (!controller.signal.aborted) setError(cause.message);
    });
    reload();
    const stream = openSessionStream(run.sessionId, {
      onRunControl: reload,
      onRunFinished: reload,
      onStatus: connected => { if (connected) reload(); },
    });
    const timer = setInterval(reload, 10_000);
    return () => { controller.abort(); clearInterval(timer); stream.close(); };
  }, [refresh, run.sessionId]);

  async function act(input: HandoffAction) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "The handoff could not be updated.");
      setState(body);
      updateRef.current(body.run);
      setOpen(false);
      setNote("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The handoff could not be updated.");
      await refresh().catch(() => {});
    } finally { setBusy(false); }
  }

  const current = state?.run ?? run;
  const mine = current.driverUserId === userId;
  const pending = state?.offers.find(offer => offer.status === "pending");
  const active = current.status === "running" || current.status === "queued";
  const eligible = pending && canEdit && !mine && (!pending.toUserId || pending.toUserId === userId);
  const version = current.controlVersion;
  return (
    <section aria-label="Chat control" className="shrink-0 border-b border-vs-border px-4 pb-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${active ? "bg-vs-success" : "bg-vs-muted"}`} />
        <span className="min-w-0 flex-1 truncate text-vs-muted" title={`${current.driverName} is driving${active ? " · Turn in progress" : ""}`}>
          {mine ? "You are driving" : `${current.driverName} is driving`}{active && <span className="ml-2 text-vs-success">Working</span>}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {children}
          <button className="rounded-md px-2 py-1.5 font-medium text-vs-muted transition hover:bg-vs-hover hover:text-vs-fg" onClick={() => setOpen(true)}>{pending ? "View handoff" : mine && canEdit ? "Hand off" : "Handoff history"}</button>
        </div>
      </div>
      {pending && <div className="mt-2 space-y-2 rounded-lg border border-vs-accent/25 bg-vs-panel p-3">
        <p>{pending.fromName} offered control to <strong>{pending.toName ?? "any room editor"}</strong>.</p>
        {pending.note && <p className="whitespace-pre-wrap break-words text-vs-muted">{pending.note}</p>}
        {active && <p className="text-vs-muted">Acceptance unlocks when the current turn safely finishes.</p>}
        <div className="flex flex-wrap gap-2">
          {eligible && <button className={`${button} border-vs-accent text-vs-accent`} disabled={busy || active} onClick={() => void act({ action: "accept", handoffId: pending.id, version })}>Accept control</button>}
          {eligible && pending.toUserId && <button className={button} disabled={busy} onClick={() => void act({ action: "decline", handoffId: pending.id, version })}>Decline</button>}
          {mine && <button className={button} disabled={busy} onClick={() => void act({ action: "cancel", handoffId: pending.id, version })}>Cancel offer</button>}
        </div>
      </div>}
      {error && <p role="alert" className="mt-2 text-vs-danger">{error}</p>}
      {open && <Modal title="Hand off this chat" description="Transfer control between turns. Accepting never starts an agent or spends compute." onClose={() => { if (!busy) setOpen(false); }}>
        {current.controlVersion > 0 && mine && <p className="text-sm text-vs-muted">You have control of this chat. Review the conversation and any uploaded checkpoint before sending your next prompt.</p>}
        {mine && canEdit && !pending && <form className="space-y-4" onSubmit={event => { event.preventDefault(); void act({ action: "offer", toUserId: recipient || null, note, version }); }}>
          <label className="block text-sm">Recipient
            <select aria-label="Handoff recipient" className="mt-1 w-full rounded-lg border border-vs-border bg-vs-editor p-2" value={recipient} onChange={event => setRecipient(event.target.value)} disabled={!state || busy}>
              <option value="">Any room editor</option>
              {state?.recipients.filter(person => person.id !== userId).map(person => <option key={person.id} value={person.id}>{person.name}</option>)}
            </select>
          </label>
          <label className="block text-sm">Where should they pick up?
            <textarea className="mt-1 min-h-28 w-full rounded-lg border border-vs-border bg-vs-editor p-2" value={note} maxLength={1000} onChange={event => setNote(event.target.value)} placeholder="What is done, what remains, and anything to watch out for…" />
          </label>
          <p className="text-xs text-vs-muted">The offer expires in one hour. Access is not granted by a handoff. Only confirmed repository state is transferred.</p>
          <button className="rounded-lg bg-vs-accent px-3 py-2 text-sm font-medium text-vs-accent-fg hover:opacity-90 disabled:opacity-50" disabled={busy || !state} type="submit">{busy ? "Creating offer…" : "Offer handoff"}</button>
        </form>}
        {pending && <p className="text-sm text-vs-muted">An offer is waiting for {pending.toName ?? "an eligible editor"}. Close this dialog to accept, decline, or cancel it.</p>}
        <div className="space-y-3 border-t border-vs-border pt-3">
          <h3 className="text-sm font-semibold">Recent handoffs</h3>
          {state?.offers.length === 0 && <p className="text-sm text-vs-muted">No handoffs yet.</p>}
          {state?.offers.map(offer => <div key={offer.id} className="rounded-lg bg-vs-editor p-3 text-xs">
            <p>{offer.fromName} → {offer.acceptedName ?? offer.toName ?? "Any editor"}<span className="ml-2 text-vs-muted">{offer.status}</span></p>
            {offer.note && <p className="mt-1 whitespace-pre-wrap break-words text-vs-muted">{offer.note}</p>}
            {offer.checkpointSha && <p className="mt-1 font-mono text-vs-muted">Checkpoint {offer.checkpointSha.slice(0, 8)}</p>}
          </div>)}
        </div>
        {isOwner && <button className={button} disabled={busy} onClick={() => void act({ action: "recover", version })}>Recover unavailable driver / abandoned turn</button>}
        {error && <p role="alert" className="text-sm text-vs-danger">{error}</p>}
      </Modal>}
    </section>
  );
}
