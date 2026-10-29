"use client";

import { useEffect, useState } from "react";
import { relativeTime } from "../../lib/format";
import {
  createShareLink,
  fetchShareLinks,
  revokeShareLink,
} from "../../lib/session/client";
import { buildShareLink } from "../../lib/session/share";
import type { Session, ShareLink, ShareRole } from "../../lib/session/types";
import { CheckIcon, ShieldIcon, SpinnerIcon } from "../icons";
import { GhostButton, inputClass, Modal } from "../ui/Modal";

/**
 * Two ways to let someone in, and the difference between them is the whole
 * point of the surface:
 *
 *   share link  carries a role the recipient cannot change, and can be revoked
 *               on its own without disturbing anyone else's access.
 *   access code short enough to read out loud, permanent, and therefore only
 *               ever grants read access.
 */
export function InviteDialog({ session, onClose }: { session: Session; onClose: () => void }) {
  const isOwner = session.myRole === "owner";

  const [role, setRole] = useState<ShareRole>("viewer");
  // Non-owners never fetch, so they start at "none" rather than "loading".
  const [links, setLinks] = useState<ShareLink[] | null>(isOwner ? null : []);
  const [minted, setMinted] = useState<{ id: string; url: string; role: ShareRole } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOwner) return;
    let cancelled = false;
    fetchShareLinks(session.id).then((list) => !cancelled && setLinks(list));
    return () => {
      cancelled = true;
    };
  }, [session.id, isOwner]);

  async function mint() {
    setBusy(true);
    setError(null);
    try {
      const created = await createShareLink(session.id, role);
      setMinted({
        id: created.link.id,
        url: buildShareLink(session.id, created.token),
        role: created.link.role,
      });
      setLinks((previous) => [created.link, ...(previous ?? [])]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create a share link.");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(linkId: string) {
    setLinks((previous) => (previous ?? []).filter((link) => link.id !== linkId));
    if (minted?.id === linkId) setMinted(null);
    try {
      await revokeShareLink(session.id, linkId);
    } catch {
      setLinks(await fetchShareLinks(session.id));
    }
  }

  return (
    <Modal
      title={`Share room “${session.name}”`}
      description={
        isOwner
          ? "A link to this room: its files, chats and terminal. Choose what it grants before you create it."
          : "Only the room’s owner can create share links."
      }
      onClose={onClose}
      footer={<GhostButton onClick={onClose}>Done</GhostButton>}
    >
      {session.orgId && <p className="rounded-xl border border-vs-border p-3 text-sm leading-6 text-vs-muted">Room links work for people already on your team: they see everything in this room. To add someone new, invite them to the team from the team overview. To show one conversation to anyone, even outside the team, open that chat and choose <strong className="text-vs-fg">Share chat</strong>: they get that conversation only.</p>}
      {isOwner && (
        <>
          <div>
            <span className="text-[12px] font-semibold uppercase tracking-wider text-vs-muted">
              New share link
            </span>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              <RoleCard
                selected={role === "viewer"}
                onSelect={() => setRole("viewer")}
                title="Can view"
                detail="Open the session, read every file, watch the terminal. Saving is refused."
              />
              <RoleCard
                selected={role === "editor"}
                onSelect={() => setRole("editor")}
                title="Can edit"
                detail="Everything a viewer can do, plus saving files — each save is a commit in their name."
              />
            </div>

            <button
              type="button"
              onClick={mint}
              disabled={busy}
              className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg bg-vs-accent px-4 py-2 text-base font-medium text-vs-accent-fg transition hover:opacity-90 disabled:opacity-60"
            >
              {busy && <SpinnerIcon className="h-4 w-4" />}
              Create {role === "editor" ? "edit" : "view"} link
            </button>
          </div>

          {minted && (
            <CopyRow
              label={`Share link — ${minted.role === "editor" ? "can edit" : "can view"}`}
              value={minted.url}
              hint="Copy it now. Only a hash is stored, so this link cannot be shown again — revoke and create another if you lose it."
            />
          )}

          {error && (
            <p className="rounded-lg border border-vs-danger/40 bg-vs-danger/10 px-3 py-2 text-sm text-vs-danger">
              {error}
            </p>
          )}

          <ActiveLinks links={links} onRevoke={revoke} />
        </>
      )}

      <CopyRow label="Access code — always view only" value={session.joinCode} spaced />

      <p className="flex items-start gap-2 rounded-lg border border-vs-border bg-vs-editor px-3 py-2.5 text-[12px] leading-5 text-vs-muted">
        <ShieldIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-vs-accent" />
        The code can be read out loud but not revoked on its own, so it only ever grants read
        access. Anything more has to be a link you can take back.
      </p>
    </Modal>
  );
}

function RoleCard({
  selected,
  onSelect,
  title,
  detail,
}: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  detail: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`rounded-lg border px-3 py-2.5 text-left transition ${
        selected
          ? "border-vs-accent bg-vs-accent/10"
          : "border-vs-border hover:bg-vs-hover"
      }`}
    >
      <span className="flex items-center gap-1.5 text-[14px] font-medium text-vs-fg">
        <span
          className={`h-3 w-3 shrink-0 rounded-full border ${
            selected ? "border-vs-accent bg-vs-accent" : "border-vs-border"
          }`}
        />
        {title}
      </span>
      <span className="mt-1 block text-[12px] leading-4 text-vs-muted">{detail}</span>
    </button>
  );
}

function ActiveLinks({
  links,
  onRevoke,
}: {
  links: ShareLink[] | null;
  onRevoke: (linkId: string) => void;
}) {
  if (links === null) {
    return (
      <p className="flex items-center gap-2 text-[12px] text-vs-muted">
        <SpinnerIcon className="h-3 w-3" />
        Loading links…
      </p>
    );
  }
  if (links.length === 0) return null;

  return (
    <div>
      <span className="text-[12px] font-semibold uppercase tracking-wider text-vs-muted">
        Active links ({links.length})
      </span>
      <ul className="mt-1.5 space-y-1">
        {links.map((link) => (
          <li
            key={link.id}
            className="flex items-center gap-2 rounded-lg border border-vs-border px-2.5 py-1.5 text-[12px]"
          >
            <span
              className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[11px] ${
                link.role === "editor"
                  ? "bg-vs-accent/15 text-vs-accent"
                  : "bg-vs-hover text-vs-muted"
              }`}
            >
              {link.role === "editor" ? "edit" : "view"}
            </span>
            <span className="min-w-0 flex-1 truncate text-vs-muted">
              created {relativeTime(Math.floor(link.createdAt / 1000))}
              {link.uses > 0 && ` · used ${link.uses}×`}
            </span>
            <button
              type="button"
              onClick={() => onRevoke(link.id)}
              className="shrink-0 rounded px-1.5 py-0.5 text-vs-muted transition hover:bg-vs-hover hover:text-vs-danger"
            >
              Revoke
            </button>
          </li>
        ))}
      </ul>
      <p className="mt-1.5 text-[12px] leading-4 text-vs-muted">
        Revoking stops new people using the link. Anyone who already joined keeps their access —
        remove them from the session to change that.
      </p>
    </div>
  );
}

function CopyRow({
  label,
  value,
  spaced,
  hint,
}: {
  label: string;
  value: string;
  spaced?: boolean;
  hint?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div>
      <span className="text-[12px] font-semibold uppercase tracking-wider text-vs-muted">
        {label}
      </span>
      <div className="mt-1.5 flex gap-2">
        <input
          readOnly
          value={value}
          onFocus={(event) => event.currentTarget.select()}
          className={`${inputClass} mt-0 font-mono ${spaced ? "tracking-[0.14em]" : ""}`}
        />
        <button
          type="button"
          onClick={copy}
          className="flex shrink-0 items-center gap-1.5 rounded-lg border border-vs-border px-3 py-2 text-base transition hover:bg-vs-hover"
        >
          {copied && <CheckIcon className="h-3.5 w-3.5 text-vs-success" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {hint && <p className="mt-1.5 text-[12px] leading-4 text-vs-muted">{hint}</p>}
    </div>
  );
}
