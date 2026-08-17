"use client";

import { useState } from "react";
import { TEAM } from "../../lib/members";
import type { Session } from "../../lib/session/types";
import { AlertIcon, CheckIcon, CloseIcon } from "../icons";
import { Avatar } from "./chat";

/**
 * Invite surface. Sending an invite is not wired to a backend yet — the form is
 * intentionally inert. What is real is the pairing shown here: the link alone
 * cannot open the session, so the code has to travel separately.
 */
export function InviteDialog({ session, onClose }: { session: Session; onClose: () => void }) {
  const sessionUrl =
    typeof window === "undefined" ? `/s/${session.id}` : `${window.location.origin}/s/${session.id}`;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Invite to session"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
      onClick={onClose}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        className="w-full max-w-lg overflow-hidden rounded-xl border border-vs-border bg-vs-panel text-vs-fg shadow-2xl"
      >
        <header className="flex items-center gap-2 border-b border-vs-border px-5 py-3.5">
          <h2 className="text-sm font-semibold">Invite to “{session.name}”</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close invite dialog"
            className="ml-auto rounded p-1 text-vs-muted transition hover:bg-vs-hover hover:text-vs-fg"
          >
            <CloseIcon className="h-4 w-4" />
          </button>
        </header>

        <div className="space-y-4 px-5 py-4">
          <CopyRow label="Session link" value={sessionUrl} />
          <CopyRow label="Access code" value={session.joinCode} mono />

          <p className="flex items-start gap-2 rounded-lg border border-vs-border bg-vs-editor px-3 py-2.5 text-[11px] leading-5 text-vs-muted">
            <AlertIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
            Both halves are needed. Anyone who only has the link — because it was copied out of a
            browser or forwarded on — lands on a locked screen. Send the code over a different
            channel.
          </p>

          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-vs-muted">
              Send an invite
            </p>
            <div className="mt-1.5 flex gap-2">
              <input
                disabled
                placeholder="teammate@example.com"
                className="min-w-0 flex-1 cursor-not-allowed rounded-lg border border-vs-border bg-vs-editor px-3 py-2 text-sm text-vs-fg placeholder:text-vs-muted"
              />
              <button
                type="button"
                disabled
                className="cursor-not-allowed rounded-lg border border-vs-border px-4 py-2 text-sm text-vs-muted"
              >
                Send
              </button>
            </div>
            <p className="mt-1.5 text-[11px] text-vs-muted">
              Not connected yet — share the link and code manually for now.
            </p>
          </div>

          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-vs-muted">In session</p>
            <ul className="mt-2 flex flex-wrap gap-3">
              {TEAM.map((member) => (
                <li key={member.id} className="flex items-center gap-2">
                  <Avatar member={member} size="sm" />
                  <span className="text-xs">{member.name}</span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[11px] text-vs-muted">
              Placeholder roster — presence is not connected yet either.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function CopyRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
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
      <p className="text-xs font-medium uppercase tracking-wide text-vs-muted">{label}</p>
      <div className="mt-1.5 flex gap-2">
        <input
          readOnly
          value={value}
          onFocus={(event) => event.currentTarget.select()}
          className={`min-w-0 flex-1 rounded-lg border border-vs-border bg-vs-editor px-3 py-2 text-sm text-vs-fg outline-none ${
            mono ? "font-mono tracking-[0.12em]" : "font-mono"
          }`}
        />
        <button
          type="button"
          onClick={copy}
          className="flex shrink-0 items-center gap-1.5 rounded-lg border border-vs-border px-3 py-2 text-sm transition hover:bg-vs-hover"
        >
          {copied && <CheckIcon className="h-3.5 w-3.5 text-emerald-500" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}
