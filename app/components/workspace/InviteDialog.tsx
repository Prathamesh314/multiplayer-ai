"use client";

import { useState } from "react";
import { TEAM } from "../../lib/members";
import type { Session } from "../../lib/session/types";
import { CheckIcon, ShieldIcon } from "../icons";
import { GhostButton, inputClass, Modal } from "../ui/Modal";
import { Avatar } from "./chat";

/**
 * Invite surface. Sending an invite is not wired to a backend yet — that form is
 * intentionally inert. What is real is the pairing shown here: the link alone
 * cannot open the session, so the code has to travel separately.
 */
export function InviteDialog({ session, onClose }: { session: Session; onClose: () => void }) {
  const sessionUrl =
    typeof window === "undefined"
      ? `/s/${session.id}`
      : `${window.location.origin}/s/${session.id}`;

  return (
    <Modal
      title={`Invite to “${session.name}”`}
      description="Send the link and the code separately — one without the other will not open the session."
      onClose={onClose}
      footer={<GhostButton onClick={onClose}>Done</GhostButton>}
    >
      <CopyRow label="Session link" value={sessionUrl} />
      <CopyRow label="Access code" value={session.joinCode} spaced />

      <p className="flex items-start gap-2 rounded-lg border border-vs-border bg-vs-editor px-3 py-2.5 text-[11px] leading-5 text-vs-muted">
        <ShieldIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-vs-accent" />
        Anyone who only has the link — because it was copied out of a browser or forwarded on —
        lands on a locked screen.
      </p>

      <div>
        <span className="text-[11px] font-semibold uppercase tracking-wider text-vs-muted">
          Send an invite
        </span>
        <div className="mt-1.5 flex gap-2">
          <input
            disabled
            placeholder="teammate@example.com"
            className={`${inputClass} mt-0 cursor-not-allowed`}
          />
          <button
            type="button"
            disabled
            className="shrink-0 cursor-not-allowed rounded-lg border border-vs-border px-4 py-2 text-sm text-vs-muted"
          >
            Send
          </button>
        </div>
        <p className="mt-1.5 text-[11px] text-vs-muted">
          Not connected yet — share the link and code manually for now.
        </p>
      </div>

      <div>
        <span className="text-[11px] font-semibold uppercase tracking-wider text-vs-muted">
          In session
        </span>
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
    </Modal>
  );
}

function CopyRow({ label, value, spaced }: { label: string; value: string; spaced?: boolean }) {
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
      <span className="text-[11px] font-semibold uppercase tracking-wider text-vs-muted">
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
          className="flex shrink-0 items-center gap-1.5 rounded-lg border border-vs-border px-3 py-2 text-sm transition hover:bg-vs-hover"
        >
          {copied && <CheckIcon className="h-3.5 w-3.5 text-emerald-500" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}
