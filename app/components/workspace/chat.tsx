"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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

/** A chat (agent run) that can be referenced with `@room/<run-id>`. */
export type MentionChat = { runId: string; title: string };
/** A room and its chats, offered by the composer's @-mention picker. */
export type MentionRoom = { sessionId: string; name: string; chats: MentionChat[] };

/** A run id anywhere in the draft — the parseable half of an `@room/<run-id>` token. */
const RUN_ID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** The referenced run ids in a draft: picked tokens, or a pasted chat path. */
function refsFromText(text: string): string[] {
  return [...new Set((text.match(RUN_ID_RE) ?? []).map((id) => id.toLowerCase()))];
}

/** The active `@…` fragment ending at the caret, or null. `@` must start a word. */
function activeMention(text: string, caret: number): { at: number; frag: string } | null {
  for (let i = caret - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === "\n") return null;
    if (ch === "@") {
      const prev = i === 0 ? " " : text[i - 1];
      return /\s/.test(prev) ? { at: i, frag: text.slice(i + 1, caret) } : null;
    }
  }
  return null;
}

type MentionState =
  | { stage: "room"; at: number; query: string }
  | { stage: "chat"; at: number; roomId: string; query: string };

export function Composer({
  placeholder,
  onSend,
  /** A larger, multi-line input — used for the AI chat where prompts are longer. */
  tall,
  /** Constrain the box and centre it, so it does not span the whole pane. */
  narrow,
  /** A toolbar rendered inside the box (e.g. provider / model / capacity chips). */
  footer,
  /** Rooms whose chats can be referenced by typing "@"; omit to disable mentions. */
  mentions,
}: {
  placeholder: string;
  onSend: (text: string, refs: string[]) => void;
  tall?: boolean;
  narrow?: boolean;
  footer?: React.ReactNode;
  mentions?: MentionRoom[];
}) {
  const [draft, setDraft] = useState("");
  const [mention, setMention] = useState<MentionState | null>(null);
  const [highlight, setHighlight] = useState(0);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const caretRef = useRef(0);
  const [pendingCaret, setPendingCaret] = useState<number | null>(null);

  const rooms = mentions ?? [];
  const mentionsOn = rooms.length > 0;

  // Restore the caret after a programmatic insert (React reset it on re-render).
  useEffect(() => {
    if (pendingCaret == null || !taRef.current) return;
    taRef.current.focus();
    taRef.current.setSelectionRange(pendingCaret, pendingCaret);
    setPendingCaret(null);
  }, [pendingCaret, draft]);

  // The list shown in the popover for the current stage/query.
  const items = useMemo<{ id: string; label: string; sub?: string }[]>(() => {
    if (!mention) return [];
    const q = mention.query.trim().toLowerCase();
    if (mention.stage === "room") {
      return rooms
        .filter((room) => room.name.toLowerCase().includes(q))
        .map((room) => ({ id: room.sessionId, label: room.name, sub: `${room.chats.length} chats` }));
    }
    const room = rooms.find((r) => r.sessionId === mention.roomId);
    return (room?.chats ?? [])
      .filter((chat) => chat.title.toLowerCase().includes(q))
      .map((chat) => ({ id: chat.runId, label: chat.title }));
  }, [mention, rooms]);

  // Show the popover whenever there's a live mention with something to show —
  // and in chat stage even with zero chats, so an empty room reads "No chats
  // yet" rather than the popover vanishing.
  const popoverOpen =
    mentionsOn && mention != null && (items.length > 0 || mention.stage === "chat");

  /** Recompute the mention state from the textarea's current text + caret. */
  function syncMention(text: string, caret: number) {
    if (!mentionsOn) return setMention(null);
    const m = activeMention(text, caret);
    if (!m) return setMention(null);
    const slash = m.frag.indexOf("/");
    if (slash >= 0) {
      const roomName = m.frag.slice(0, slash).trim();
      // Keep the room the user actually picked (by id) while its name still
      // matches — room names aren't unique, so re-finding by name alone could
      // silently jump to a different room that happens to share the name.
      const prior =
        mention?.stage === "chat" ? rooms.find((r) => r.sessionId === mention.roomId) : null;
      const room = prior && prior.name === roomName ? prior : rooms.find((r) => r.name === roomName);
      // A '/' with a known room ahead of it means we're choosing a chat; a
      // token that already carries a run id (a completed pick) is not a mention.
      if (room && !m.frag.match(RUN_ID_RE)) {
        setMention({ stage: "chat", at: m.at, roomId: room.sessionId, query: m.frag.slice(slash + 1) });
      } else {
        setMention(null);
      }
      return;
    }
    // Only stay open in room stage while something still matches, so an ordinary
    // "@handle" elsewhere doesn't trap the popover.
    const anyMatch = rooms.some((r) => r.name.toLowerCase().includes(m.frag.toLowerCase()));
    setMention(m.frag.length > 0 && !anyMatch ? null : { stage: "room", at: m.at, query: m.frag });
    setHighlight(0);
  }

  function onDraftChange(text: string, caret: number) {
    caretRef.current = caret;
    setDraft(text);
    syncMention(text, caret);
  }

  /** Replace the active `@…` fragment with `insert`; keep typing from `nextCaret`. */
  function applyInsert(insert: string): number {
    const at = mention!.at;
    const before = draft.slice(0, at);
    const after = draft.slice(caretRef.current);
    const next = `${before}${insert}${after}`;
    setDraft(next);
    const caret = at + insert.length;
    caretRef.current = caret;
    setPendingCaret(caret);
    return caret;
  }

  function pick(id: string) {
    if (!mention) return;
    if (mention.stage === "room") {
      const room = rooms.find((r) => r.sessionId === id);
      if (!room) return;
      applyInsert(`@${room.name}/`);
      setMention({ stage: "chat", at: mention.at, roomId: room.sessionId, query: "" });
      setHighlight(0);
      return;
    }
    const room = rooms.find((r) => r.sessionId === mention.roomId);
    if (!room) return;
    // The run id in the token is what the server resolves; the room name is just
    // for reading. Trailing space so the next keystroke isn't glued to it.
    applyInsert(`@${room.name}/${id} `);
    setMention(null);
  }

  function send() {
    const text = draft.trim();
    if (!text) return;
    onSend(text, refsFromText(text));
    setDraft("");
    setMention(null);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (popoverOpen) {
      if (event.key === "Escape") {
        event.preventDefault();
        setMention(null);
        return;
      }
      if (items.length > 0) {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setHighlight((h) => (h + 1) % items.length);
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          setHighlight((h) => (h - 1 + items.length) % items.length);
          return;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          event.preventDefault();
          pick(items[Math.min(highlight, items.length - 1)].id);
          return;
        }
      }
      // Enter never submits while the picker is open (e.g. an empty room).
      if (event.key === "Enter") {
        event.preventDefault();
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  }

  const popover = popoverOpen && (
    <div className="absolute bottom-full left-0 z-20 mb-1 w-72 overflow-hidden rounded-lg border border-vs-border bg-vs-panel shadow-lg">
      <div className="border-b border-vs-border px-2.5 py-1.5 text-[10px] uppercase tracking-wider text-vs-muted">
        {mention?.stage === "room" ? "Reference a room" : "Pick a chat"}
      </div>
      {items.length === 0 ? (
        <p className="px-2.5 py-2 text-[11px] text-vs-muted">No chats yet in this room.</p>
      ) : (
      <ul className="vs-scroll max-h-56 overflow-y-auto py-1">
        {items.map((item, index) => (
          <li key={item.id}>
            <button
              type="button"
              onMouseDown={(event) => {
                event.preventDefault();
                pick(item.id);
              }}
              onMouseEnter={() => setHighlight(index)}
              className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px] ${
                index === highlight ? "bg-vs-hover text-vs-fg" : "text-vs-fg/90"
              }`}
            >
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {item.sub && <span className="shrink-0 text-[10px] text-vs-muted">{item.sub}</span>}
            </button>
          </li>
        ))}
      </ul>
      )}
    </div>
  );

  const textarea = (
    <textarea
      ref={taRef}
      value={draft}
      onChange={(event) => onDraftChange(event.target.value, event.target.selectionStart ?? event.target.value.length)}
      onKeyUp={(event) => (caretRef.current = event.currentTarget.selectionStart ?? 0)}
      onClick={(event) => {
        caretRef.current = event.currentTarget.selectionStart ?? 0;
        syncMention(draft, caretRef.current);
      }}
      onKeyDown={onKeyDown}
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
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-vs-accent text-vs-accent-fg transition hover:opacity-90 disabled:opacity-30"
    >
      <SendIcon className="h-3.5 w-3.5" />
    </button>
  );

  return (
    <div className="shrink-0 border-t border-vs-border p-2">
      <div className={`relative ${narrow ? "mx-auto w-full max-w-4xl" : ""}`}>
        {popover}
        {footer ? (
          <div className="rounded-2xl border border-vs-border bg-vs-panel px-3 py-2.5 shadow-sm focus-within:border-vs-muted">
            <div className="flex">{textarea}</div>
            <div className="mt-1.5 flex items-center gap-1">
              {footer}
              <div className="ml-auto">{sendButton}</div>
            </div>
          </div>
        ) : (
          <div className="flex items-end gap-1.5 rounded-2xl border border-vs-border bg-vs-panel px-2.5 py-2 shadow-sm focus-within:border-vs-muted">
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
