"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { AgentRun } from "../../lib/ai/runs";
import type { ChatInvitation, ChatShareRole } from "../../lib/sharing/types";
import { sharedChatApi, sharedChatPath, sharingRequest } from "../../lib/sharing/client";
import { ErrorNote, GhostButton, inputClass, Modal, PrimaryButton } from "../ui/Modal";
import { useToast } from "../ui/Toast";
import { ComposerPicker } from "./ComposerPicker";
import { GuestAccess } from "../collaboration/GuestAccess";
import { LinkIcon, ShieldIcon } from "../icons";

/*
 * Sharing a chat the way a document is shared: add people by email (they open
 * the chat's own link while signed in with that email), and choose whether
 * anyone with the link can open it. Only the chat's human and AI messages are
 * shared, never the room's files, tools or settings.
 */

type ChatLink = { role: ChatShareRole; token: string } | null;
const roleOptions = [
  { id: "viewer", label: "Viewer", description: "Read this conversation and its comments." },
  { id: "commenter", label: "Commenter", description: "Read and discuss. Comments do not run AI or change files." },
];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const initial = (value: string) => (value.trim()[0] ?? "?").toUpperCase();

export function ShareChatDialog({ run, onClose }: { run: AgentRun; onClose: () => void }) {
  const { notify } = useToast();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<ChatShareRole>("viewer");
  const [sendNotice, setSendNotice] = useState(true);
  const [message, setMessage] = useState("");
  const [people, setPeople] = useState<ChatInvitation[]>([]);
  const [link, setLink] = useState<ChatLink>(null);
  const [canNotify, setCanNotify] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [canManage, setCanManage] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const endpoint = `${sharedChatApi(run.id)}/invitations`;

  useEffect(() => {
    const controller = new AbortController();
    void sharingRequest<{ invitations: ChatInvitation[]; link: ChatLink; canNotify: boolean }>(endpoint, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) })
      .then((data) => { if (!controller.signal.aborted) { setPeople(data.invitations); setLink(data.link); setCanNotify(data.canNotify); setCanManage(true); setNow(Date.now()); } })
      .catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Couldn’t load who has access."); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [endpoint]);

  const active = people.filter((item) => !item.revokedAt && (!item.expiresAt || Date.parse(item.expiresAt) > now));
  const typed = email.trim();

  async function share(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !EMAIL.test(typed)) return;
    setBusy(true); setError(null);
    try {
      const result = await sharingRequest<{ invitation: ChatInvitation; notified: boolean }>(endpoint, {
        method: "POST", body: JSON.stringify({ email: typed, role, notify: canNotify && sendNotice, message: message.trim() || undefined }),
      });
      setPeople((items) => [result.invitation, ...items.filter((item) => item.email.toLowerCase() !== result.invitation.email.toLowerCase())]);
      setEmail(""); setMessage("");
      notify({ title: `Shared with ${result.invitation.email}`, description: result.notified ? "We emailed them a link." : "Copy the link and send it to them. They sign in with that email to open it." });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Couldn’t share the chat."); }
    finally { setBusy(false); }
  }

  async function changeRole(person: ChatInvitation, next: string) {
    if (busy || next === person.role) return;
    setBusy(true); setError(null);
    try {
      if (next === "remove") {
        await sharingRequest(endpoint, { method: "DELETE", body: JSON.stringify({ id: person.id }) });
        setPeople((items) => items.filter((item) => item.id !== person.id));
        notify({ title: `Removed ${person.email}`, description: "They can no longer open this chat unless anyone with the link can." });
      } else {
        const result = await sharingRequest<{ invitation: ChatInvitation }>(endpoint, { method: "POST", body: JSON.stringify({ email: person.email, role: next, notify: false }) });
        setPeople((items) => items.map((item) => (item.id === person.id ? result.invitation : item)));
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Couldn’t change access. Try again."); }
    finally { setBusy(false); }
  }

  async function changeLink(next: string) {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const result = await sharingRequest<{ link: ChatLink }>(`${sharedChatApi(run.id)}/link`, { method: "PUT", body: JSON.stringify({ role: next === "restricted" ? null : next }) });
      setLink(result.link);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Couldn’t change general access."); }
    finally { setBusy(false); }
  }

  function copyLink() {
    const url = `${location.origin}${sharedChatPath(run.id)}${link ? `#link=${encodeURIComponent(link.token)}` : ""}`;
    void navigator.clipboard.writeText(url)
      .then(() => notify({ title: "Link copied", description: link ? `Anyone with this link can ${link.role === "commenter" ? "comment" : "view"}.` : "Only people with access can open it." }))
      .catch(() => setError(`Couldn’t copy automatically. The link is ${url}`));
  }

  return (
    <Modal
      title={`Share “${run.title ?? "AI chat"}”`}
      description="Share this conversation, even with people outside your team. Files, tools and room settings stay private."
      onClose={onClose}
      footer={<>
        <GhostButton className="mr-auto" disabled={loading || !canManage} onClick={copyLink}><LinkIcon className="h-3.5 w-3.5" />Copy link</GhostButton>
        <PrimaryButton onClick={onClose}>Done</PrimaryButton>
      </>}
    >
      <form onSubmit={share} className="space-y-3">
        <div className="flex flex-wrap items-stretch gap-2">
          <input aria-label="Add people by email" type="email" maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} disabled={!canManage}
            className={`${inputClass} mt-0 min-w-0 flex-1 basis-56`} placeholder="Add people by email" autoComplete="email" />
          {typed && <div className="w-36 shrink-0"><ComposerPicker label="Role for new person" value={role} onChange={(value) => setRole(value as ChatShareRole)} variant="field" options={roleOptions} disabled={busy} /></div>}
        </div>
        {typed && <div className="space-y-3 rounded-xl border border-vs-border bg-vs-editor/40 p-3">
          {canNotify && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={sendNotice} onChange={(e) => setSendNotice(e.target.checked)} />Notify by email</label>}
          {canNotify && sendNotice && <textarea aria-label="Message" value={message} onChange={(e) => setMessage(e.target.value)} maxLength={1000} rows={2} className={`${inputClass} mt-0 resize-y`} placeholder="Message (optional)" />}
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs leading-5 text-vs-muted">They open it signed in with this email.{canNotify ? "" : " Copy the link to send it."}</p>
            <PrimaryButton type="submit" disabled={busy || !EMAIL.test(typed)}>{busy ? "Sharing…" : "Share"}</PrimaryButton>
          </div>
        </div>}
      </form>
      {error && <ErrorNote>{error}</ErrorNote>}

      <section aria-label="People with access">
        <h3 className="text-sm font-semibold">People with access</h3>
        <ul className="mt-2 space-y-1">
          <li className="flex items-center gap-3 py-1.5">
            <span aria-hidden className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-vs-accent text-sm font-semibold text-vs-accent-fg">{initial(run.driverName)}</span>
            <div className="min-w-0 flex-1"><p className="truncate text-sm">{run.driverName}</p><p className="text-xs text-vs-muted">Runs this chat</p></div>
            <span className="text-xs text-vs-muted">Owner</span>
          </li>
          {loading ? <li className="py-1.5 text-sm text-vs-muted">Loading…</li> : active.map((person) => (
            <li key={person.id} className="py-1.5">
              <div className="flex items-center gap-3">
                <span aria-hidden className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-vs-hover text-sm font-semibold">{initial(person.email)}</span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{person.email}</p>
                  <p className="text-xs text-vs-muted">
                    {person.viaLink ? `${person.acceptedAt ? "Joined" : "Invitation link sent"}${person.expiresAt ? ` · ends ${new Date(person.expiresAt).toLocaleDateString()}` : ""}` : person.acceptedAt ? "Opened" : "Hasn’t opened yet"}
                  </p>
                </div>
                <div className="w-32 shrink-0">
                  <ComposerPicker label={`Access for ${person.email}`} value={person.role} onChange={(value) => void changeRole(person, value)} variant="field" disabled={busy}
                    options={[...roleOptions, { id: "remove", label: "Remove access", description: "They can no longer open this chat." }]} />
                </div>
              </div>
              {person.acceptedAt && <div className="mt-2 pl-11"><GuestAccess runId={run.id} invitationId={person.id} /></div>}
            </li>
          ))}
        </ul>
        <p className="mt-1 text-xs leading-5 text-vs-muted">People in this room can also open the chat in the workspace.</p>
      </section>

      <section aria-label="General access">
        <h3 className="text-sm font-semibold">General access</h3>
        <div className="mt-2 flex items-start gap-3">
          <span aria-hidden className={`grid h-8 w-8 shrink-0 place-items-center rounded-full ${link ? "bg-emerald-500/15 text-emerald-300" : "bg-vs-hover text-vs-muted"}`}>
            {link ? <LinkIcon className="h-4 w-4" /> : <ShieldIcon className="h-4 w-4" />}
          </span>
          <div className="min-w-0 flex-1">
            <div className="w-56 max-w-full">
              <ComposerPicker label="General access" value={link ? "anyone" : "restricted"} variant="field" disabled={busy || loading || !canManage}
                onChange={(value) => void changeLink(value === "restricted" ? "restricted" : link?.role ?? "viewer")}
                options={[
                  { id: "restricted", label: "Restricted", description: "Only people with access can open it." },
                  { id: "anyone", label: "Anyone with the link", description: "Anyone on the internet with the link can open it, without signing in." },
                ]} />
            </div>
            <p className="mt-1 text-xs leading-5 text-vs-muted">
              {link ? `Anyone on the internet with the link can ${link.role === "commenter" ? "view, and comment after signing in" : "view"}.` : "Only people with access can open with the link."}
            </p>
          </div>
          {link && <div className="w-32 shrink-0"><ComposerPicker label="Link role" value={link.role} onChange={(value) => void changeLink(value)} variant="field" disabled={busy} options={roleOptions} /></div>}
        </div>
      </section>
      <Link href={sharedChatPath(run.id)} target="_blank" rel="noopener noreferrer" className="inline-block text-xs text-vs-accent underline underline-offset-4">Preview the shared chat & reply to comments</Link>
    </Modal>
  );
}
