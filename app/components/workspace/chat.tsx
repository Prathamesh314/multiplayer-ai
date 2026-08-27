"use client";

import { useState } from "react";
import type { Member } from "../../lib/members";
import { STATUS_COLOR } from "../../lib/members";
import { SendIcon } from "../icons";

export type ChatMessage = {
  id: string;
  /** Member id, or "ai" for an assistant turn. */
  authorId: string;
  text: string;
  /** Pre-formatted so seeded messages do not drift between server and client. */
  time: string;
};

export function Avatar({
  member,
  size = "md",
  selected,
}: {
  member: Member;
  size?: "sm" | "md";
  selected?: boolean;
}) {
  const dimensions = size === "sm" ? "h-6 w-6 text-[10px]" : "h-8 w-8 text-[11px]";

  return (
    <span className="relative inline-flex shrink-0">
      <span
        className={`inline-flex items-center justify-center rounded-full font-semibold ${dimensions} ${member.avatar} ${
          selected ? "ring-2 ring-vs-accent ring-offset-2 ring-offset-vs-panel" : ""
        }`}
      >
        {member.initials}
      </span>
      <span
        className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-vs-panel ${STATUS_COLOR[member.status]}`}
      />
    </span>
  );
}

export function MessageList({
  messages,
  authorOf,
  emptyState,
}: {
  messages: ChatMessage[];
  authorOf: (authorId: string) => { name: string; avatar: React.ReactNode };
  emptyState: React.ReactNode;
}) {
  if (messages.length === 0) {
    return (
      <div className="vs-scroll flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-4">
        {emptyState}
      </div>
    );
  }

  return (
    <div className="vs-scroll flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
      {messages.map((message) => {
        const author = authorOf(message.authorId);
        return (
          <article key={message.id} className="flex gap-2">
            {author.avatar}
            <div className="min-w-0 flex-1">
              <header className="flex items-baseline gap-2">
                <span className="truncate text-xs font-semibold text-vs-fg">{author.name}</span>
                <span className="shrink-0 text-[10px] text-vs-muted">{message.time}</span>
              </header>
              <p className="mt-0.5 whitespace-pre-wrap break-words text-[13px] leading-5 text-vs-fg/90">
                {message.text}
              </p>
            </div>
          </article>
        );
      })}
    </div>
  );
}

export function Composer({
  placeholder,
  onSend,
  /** A larger, multi-line input — used for the AI chat where prompts are longer. */
  tall,
  /** Constrain the box and centre it, so it does not span the whole pane. */
  narrow,
  /** A toolbar rendered inside the box (e.g. provider / model / capacity chips). */
  footer,
}: {
  placeholder: string;
  onSend: (text: string) => void;
  tall?: boolean;
  narrow?: boolean;
  footer?: React.ReactNode;
}) {
  const [draft, setDraft] = useState("");

  function send() {
    const text = draft.trim();
    if (!text) return;
    onSend(text);
    setDraft("");
  }

  const textarea = (
    <textarea
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          send();
        }
      }}
      rows={tall ? 4 : 1}
      placeholder={placeholder}
      className={`vs-scroll flex-1 resize-none bg-transparent text-[13px] text-vs-fg outline-none placeholder:text-vs-muted ${
        tall ? "max-h-64 min-h-24" : "max-h-28 min-h-5"
      }`}
    />
  );

  const sendButton = (
    <button
      type="button"
      onClick={send}
      disabled={draft.trim().length === 0}
      aria-label="Send message"
      className="rounded p-1 text-vs-muted transition hover:bg-vs-hover hover:text-vs-fg disabled:opacity-40 disabled:hover:bg-transparent"
    >
      <SendIcon className="h-4 w-4" />
    </button>
  );

  return (
    <div className="shrink-0 border-t border-vs-border p-2">
      <div className={narrow ? "mx-auto w-full max-w-4xl" : ""}>
        {footer ? (
          <div className="rounded-lg border border-vs-border bg-vs-editor px-2.5 py-2 focus-within:border-vs-accent">
            <div className="flex">{textarea}</div>
            <div className="mt-1.5 flex items-center gap-1">
              {footer}
              <div className="ml-auto">{sendButton}</div>
            </div>
          </div>
        ) : (
          <div className="flex items-end gap-1.5 rounded-lg border border-vs-border bg-vs-editor px-2 py-1.5 focus-within:border-vs-accent">
            {textarea}
            {sendButton}
          </div>
        )}
      </div>
    </div>
  );
}

export function clockNow(): string {
  return new Date().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

let messageCounter = 0;

export function nextMessageId(prefix: string): string {
  messageCounter += 1;
  return `${prefix}-${messageCounter}`;
}
