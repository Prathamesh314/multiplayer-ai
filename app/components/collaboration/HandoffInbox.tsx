"use client";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import type { HandoffInboxResponse } from "../../api/handoffs/route";
import type { InboxHandoff } from "../../lib/ai/handoff";
import { openUserStream } from "../../lib/events/shared-client";
import { initialsOf } from "../../lib/people";
import { ErrorNote, GhostButton, PrimaryButton } from "../ui/Modal";

/*
 * Handoffs on the dashboard, in the shape of an inbox: what is waiting for
 * you to accept, and what you offered and others have yet to take. Kept live
 * through your event stream, so an offer appears the moment it is made.
 */

export function useHandoffInbox() {
  const [data, setData] = useState<HandoffInboxResponse | null>(null);
  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/handoffs", { cache: "no-store" });
      if (response.ok) setData(await response.json() as HandoffInboxResponse);
    } catch { /* the next event, focus or expiry retries */ }
  }, []);
  useEffect(() => {
    const load = () => { if (!document.hidden) void refresh(); };
    load();
    const stream = openUserStream((type) => { if (type === "handoffs.changed") load(); }, load);
    window.addEventListener("focus", load);
    return () => { stream.close(); window.removeEventListener("focus", load); };
  }, [refresh]);
  // An offer leaves the inbox when it expires.
  useEffect(() => {
    const deadlines = [...(data?.received ?? []), ...(data?.sent ?? [])].map((item) => Date.parse(item.expiresAt)).filter(Number.isFinite);
    if (!deadlines.length) return;
    const timer = setTimeout(() => void refresh(), Math.max(1000, Math.min(...deadlines) - Date.now() + 500));
    return () => clearTimeout(timer);
  }, [data, refresh]);
  return { data, refresh };
}

function expiresIn(at: string) {
  const minutes = Math.max(0, Math.round((Date.parse(at) - Date.now()) / 60000));
  return minutes >= 60 ? `expires in ${Math.round(minutes / 60)} h` : minutes <= 1 ? "expires in a minute" : `expires in ${minutes} min`;
}
const where = (item: InboxHandoff) => [item.projectName, item.roomName].filter(Boolean).join(" · ");

/**
 * In the overview's action queue: one line per handoff. `label` heads the group
 * in the queue's All view, where an empty group shows nothing at all.
 */
export function HandoffInbox({ inbox, label }: { inbox: ReturnType<typeof useHandoffInbox>; label?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const received = inbox.data?.received ?? [], sent = inbox.data?.sent ?? [];

  async function act(item: InboxHandoff, action: "accept" | "decline" | "cancel") {
    setBusy(`${action}:${item.id}`); setError(null);
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(item.sessionId)}/runs/${encodeURIComponent(item.runId)}/handoff`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, handoffId: item.id, version: item.version }),
      });
      const body = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(body?.error ?? "Couldn’t update this handoff. Try again.");
      if (action === "accept") { router.push(`/s/${item.sessionId}?run=${item.runId}`); return; }
      await inbox.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      await inbox.refresh();
    } finally { setBusy(null); }
  }

  const empty = inbox.data !== null && !received.length && !sent.length;
  if (label && (inbox.data === null || empty) && !error) return null;
  return (
    <section id="handoffs" aria-label="Handoffs" className="text-xs">
      {label && <h3 className="border-y border-vs-border/70 bg-vs-editor/50 px-4 py-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-vs-muted">{label}</h3>}
      {error && <div className="px-4 py-3"><ErrorNote>{error}</ErrorNote></div>}
      {inbox.data === null ? (
        <p role="status" className="px-4 py-3 text-vs-muted">Checking for handoffs…</p>
      ) : empty ? (
        <p className="px-4 py-4 text-[13px] leading-5 text-vs-muted">Nothing waiting. When a teammate hands you a chat from its <span className="text-vs-fg">Handoff</span> menu, it appears here to accept.</p>
      ) : null}

      {received.length > 0 && (
        <ul className="divide-y divide-vs-border/70" aria-label="Handoffs waiting for you">
          {received.map((item) => (
            <li key={item.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 bg-vs-accent/5 px-4 py-3">
              <span aria-hidden className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-vs-active text-[10.5px] font-semibold uppercase text-vs-accent">{initialsOf(item.person ?? "?")}</span>
              <div className="min-w-0 flex-1 basis-56">
                <p className="truncate text-[13px] text-vs-fg">
                  <span className="font-semibold">{item.person}</span> {item.direct ? "handed you" : "offered anyone in the room"} <span className="font-semibold">{item.title ?? "a chat"}</span>
                </p>
                <p className="mt-0.5 truncate text-[11.5px] text-vs-muted"><span className="font-mono">{where(item)}</span> · {expiresIn(item.expiresAt)}{item.busy ? " · finishing a turn" : ""}</p>
                {item.note && <p title={item.note} className="mt-1 line-clamp-2 break-words border-l-2 border-vs-border pl-2 text-[12px] leading-5 text-vs-fg/90">{item.note}</p>}
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                <PrimaryButton disabled={!!busy || item.busy} title={item.busy ? "Wait for its current turn to finish" : undefined} onClick={() => void act(item, "accept")}>
                  {busy === `accept:${item.id}` ? "Accepting…" : "Accept & open"}
                </PrimaryButton>
                {item.direct && <GhostButton disabled={!!busy} onClick={() => void act(item, "decline")}>{busy === `decline:${item.id}` ? "Declining…" : "Decline"}</GhostButton>}
                <a href={`/s/${item.sessionId}?run=${item.runId}`} className="px-1 text-vs-muted underline-offset-2 hover:text-vs-fg hover:underline">View chat</a>
              </div>
            </li>
          ))}
        </ul>
      )}

      {sent.length > 0 && (
        <ul className="divide-y divide-vs-border/70 border-t border-vs-border/70" aria-label="Handoffs you sent">
          {sent.map((item) => (
            <li key={item.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
              <div className="min-w-0 flex-1 basis-56">
                <p className="truncate text-[13px]"><span className="font-medium text-vs-fg">{item.title ?? "A chat"}</span> <span className="text-vs-muted">→ {item.person ?? "any editor in the room"}</span></p>
                <p className="mt-0.5 truncate text-[11.5px] text-vs-muted">You sent this · <span className="font-mono">{where(item)}</span> · waiting · {expiresIn(item.expiresAt)}</p>
              </div>
              <GhostButton disabled={!!busy} onClick={() => void act(item, "cancel")}>{busy === `cancel:${item.id}` ? "Cancelling…" : "Cancel"}</GhostButton>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
