"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { colorOf, initialsOf } from "../../lib/people";
import { fetchMessages, sendMessage } from "../../lib/session/client";
import type { ChatMessage, SessionMember } from "../../lib/session/types";
import { CloseIcon, SpinnerIcon } from "../icons";
import { Composer } from "./chat";
import { PeopleStack } from "./People";

type TeamChatPanelProps = {
  sessionId: string;
  members: SessionMember[];
  /** Messages arriving over the event stream, newest last. */
  incoming: ChatMessage[];
  /** Omitted when docked as the permanent left sidebar, where there is no X. */
  onClose?: () => void;
  /** Hides the panel's own header when it sits under a section header. */
  embedded?: boolean;
};

export function TeamChatPanel({
  sessionId,
  members,
  incoming,
  onClose,
  embedded,
}: TeamChatPanelProps) {
  const [history, setHistory] = useState<ChatMessage[] | null>(null);
  /** Sent from this tab: optimistic first, then the stored version. */
  const [local, setLocal] = useState<ChatMessage[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scroller = useRef<HTMLDivElement>(null);
  /** False while reading history, so a new arrival does not yank the view. */
  const pinned = useRef(true);

  useEffect(() => {
    let cancelled = false;
    fetchMessages(sessionId).then((page) => {
      if (cancelled) return;
      setHistory(page.messages);
      setHasMore(page.hasMore);
    });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  /**
   * Three sources, one list. Derived rather than merged into state: the same
   * message arrives from the POST response and from the broadcast, and reducing
   * that in an effect would mean writing state on every event.
   */
  const messages = useMemo(() => {
    if (history === null) return null;
    const byId = new Map<string, ChatMessage>();
    for (const message of [...history, ...incoming, ...local]) byId.set(message.id, message);
    return [...byId.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }, [history, incoming, local]);

  // Following the conversation should keep following it; reading back should
  // not be interrupted.
  useEffect(() => {
    if (!pinned.current) return;
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [messages]);

  function onScroll() {
    const element = scroller.current;
    if (!element) return;
    pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
  }

  const loadOlder = useCallback(async () => {
    const oldest = messages?.[0];
    if (!oldest || loadingMore) return;

    setLoadingMore(true);
    const element = scroller.current;
    const before = element?.scrollHeight ?? 0;

    const page = await fetchMessages(sessionId, oldest.id);
    setHistory((previous) => [...page.messages, ...(previous ?? [])]);
    setHasMore(page.hasMore);
    setLoadingMore(false);

    // Hold the reading position: prepending would otherwise shove the text
    // the person is looking at off the bottom of the panel.
    requestAnimationFrame(() => {
      if (element) element.scrollTop = element.scrollHeight - before;
    });
  }, [messages, sessionId, loadingMore]);

  async function send(body: string) {
    setError(null);
    // Optimistic, with a temporary id the broadcast will replace.
    const optimistic: ChatMessage = {
      id: `pending-${Date.now()}`,
      userId: "",
      userName: "",
      handle: "",
      body,
      createdAt: Date.now(),
    };
    setLocal((previous) => [...previous, optimistic]);
    pinned.current = true;

    try {
      const saved = await sendMessage(sessionId, body);
      // Swapped rather than removed: relying on the broadcast to bring it back
      // would lose the message if that one event went missing.
      setLocal((previous) => previous.map((m) => (m.id === optimistic.id ? saved : m)));
    } catch (cause) {
      setLocal((previous) => previous.filter((m) => m.id !== optimistic.id));
      setError(cause instanceof Error ? cause.message : "Could not send that message.");
    }
  }

  return (
    <aside className="flex h-full min-h-0 w-full flex-col bg-vs-panel">
      {!embedded && (
        <PanelHeader title="Session chat" onClose={onClose}>
          <PeopleStack members={members} />
        </PanelHeader>
      )}

      <div
        ref={scroller}
        onScroll={onScroll}
        className="vs-scroll flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3"
      >
        {messages === null ? (
          <p className="flex items-center justify-center gap-2 py-4 text-xs text-vs-muted">
            <SpinnerIcon className="h-3.5 w-3.5" />
            Loading…
          </p>
        ) : messages.length === 0 ? (
          <p className="py-4 text-center text-xs leading-5 text-vs-muted">
            No messages yet. Everyone in this session sees what you write here.
          </p>
        ) : (
          <>
            {hasMore && (
              <button
                type="button"
                onClick={loadOlder}
                disabled={loadingMore}
                className="mx-auto shrink-0 rounded border border-vs-border px-2 py-1 text-[11px] text-vs-muted transition hover:bg-vs-hover hover:text-vs-fg disabled:opacity-50"
              >
                {loadingMore ? "Loading…" : "Load earlier messages"}
              </button>
            )}
            {messages.map((message, index) => (
              <Message
                key={message.id}
                message={message}
                // Consecutive messages from one person read as one turn.
                grouped={index > 0 && messages[index - 1].userId === message.userId}
              />
            ))}
          </>
        )}
      </div>

      {error && (
        <p className="shrink-0 border-t border-red-500/40 bg-red-500/10 px-3 py-1.5 text-[11px] text-red-600 dark:text-red-300">
          {error}
        </p>
      )}

      <Composer placeholder="Message the session…" onSend={send} />
    </aside>
  );
}

function Message({ message, grouped }: { message: ChatMessage; grouped: boolean }) {
  const pending = message.id.startsWith("pending-");
  const color = colorOf(message.userId || "pending");

  return (
    <article className={`flex gap-2 ${pending ? "opacity-60" : ""} ${grouped ? "-mt-2" : ""}`}>
      <span className="w-6 shrink-0">
        {!grouped && (
          <span
            className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-semibold ${color.chip}`}
          >
            {initialsOf(message.userName || "…")}
          </span>
        )}
      </span>
      <div className="min-w-0 flex-1">
        {!grouped && (
          <header className="flex items-baseline gap-2">
            <span className="truncate text-xs font-semibold text-vs-fg">
              {message.userName || "Sending…"}
            </span>
            <span className="shrink-0 text-[10px] text-vs-muted">{clockOf(message.createdAt)}</span>
          </header>
        )}
        <p className="mt-0.5 whitespace-pre-wrap break-words text-[13px] leading-5 text-vs-fg/90">
          {message.body}
        </p>
      </div>
    </article>
  );
}

function clockOf(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export function PanelHeader({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose?: () => void;
  children?: React.ReactNode;
}) {
  return (
    <header className="flex h-9 shrink-0 items-center gap-2 border-b border-vs-border px-3">
      <h2 className="text-[11px] font-semibold uppercase tracking-wider text-vs-muted">{title}</h2>
      <div className="ml-auto flex items-center gap-2">
        {children}
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label={`Close ${title}`}
            className="rounded p-0.5 text-vs-muted transition hover:bg-vs-hover hover:text-vs-fg"
          >
            <CloseIcon className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </header>
  );
}
