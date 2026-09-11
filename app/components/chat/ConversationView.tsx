"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CurrentUser } from "../../lib/auth/types";
import {
  fetchChatMessages,
  fetchConversation,
  markConversationRead,
  openChatStream,
  sendChatMessage,
} from "../../lib/chat/client";
import type { ChatMessage, Conversation } from "../../lib/chat/types";
import { colorOf, initialsOf } from "../../lib/people";
import { SpinnerIcon, UsersIcon } from "../icons";
import { Composer } from "../workspace/chat";

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** A round, deterministically-coloured avatar for a chat author. */
function Avatar({ userId, name }: { userId: string; name: string }) {
  const color = colorOf(userId);
  return (
    <span
      className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold ${color.chip}`}
    >
      {initialsOf(name)}
    </span>
  );
}

/** Insert a message in creation order, skipping one already present by id. */
function withMessage(list: ChatMessage[], message: ChatMessage): ChatMessage[] {
  if (list.some((m) => m.id === message.id)) return list;
  const next = [...list, message];
  next.sort((a, b) => (a.createdAt - b.createdAt) || a.id.localeCompare(b.id));
  return next;
}

export function ConversationView({
  conversationId,
  me,
  onRead,
}: {
  conversationId: string;
  me: CurrentUser;
  /** Fired when the open conversation is read or receives a message, so the
   *  sidebar can refresh its unread counts and ordering. */
  onRead?: () => void;
}) {
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  // Load the conversation + its first page. The parent keys this component by
  // conversation id, so it remounts on selection — no need to reset state here.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [conv, page] = await Promise.all([
          fetchConversation(conversationId),
          fetchChatMessages(conversationId),
        ]);
        if (cancelled) return;
        setConversation(conv);
        setMessages(page.messages);
        setHasMore(page.hasMore);
        pinnedRef.current = true;
        onRead?.();
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not open this conversation.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId, onRead]);

  // Live delivery. The sender's own message arrives here too and is reconciled
  // by id, so the optimistic copy is never duplicated.
  useEffect(() => {
    const stream = openChatStream(conversationId, {
      onStatus: setLive,
      onMessage: (event) => {
        if (event.conversationId !== conversationId) return;
        setMessages((prev) => withMessage(prev, event.message));
        if (event.message.userId !== me.id) {
          void markConversationRead(conversationId);
          onRead?.();
        }
      },
    });
    return () => stream.close();
  }, [conversationId, me.id, onRead]);

  // Keep the view pinned to the newest message unless the reader scrolled up.
  useEffect(() => {
    if (!pinnedRef.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);

  async function loadEarlier() {
    const oldest = messages[0];
    if (!oldest || loadingMore) return;
    setLoadingMore(true);
    const el = scrollRef.current;
    const before = el ? el.scrollHeight - el.scrollTop : 0;
    try {
      const page = await fetchChatMessages(conversationId, oldest.id);
      setMessages((prev) => {
        const seen = new Set(prev.map((m) => m.id));
        return [...page.messages.filter((m) => !seen.has(m.id)), ...prev];
      });
      setHasMore(page.hasMore);
      // Preserve the reading position across the prepend.
      requestAnimationFrame(() => {
        if (el) el.scrollTop = el.scrollHeight - before;
      });
    } catch {
      // Leave the history as-is; the button stays for a retry.
    } finally {
      setLoadingMore(false);
    }
  }

  async function onSend(text: string) {
    const pendingId = `pending-${Date.now()}`;
    const optimistic: ChatMessage = {
      id: pendingId,
      userId: me.id,
      userName: me.displayName,
      handle: me.handle,
      body: text,
      createdAt: Date.now(),
    };
    pinnedRef.current = true;
    setMessages((prev) => [...prev, optimistic]);
    try {
      const saved = await sendChatMessage(conversationId, text);
      setMessages((prev) => withMessage(prev.filter((m) => m.id !== pendingId), saved));
      onRead?.();
    } catch (cause) {
      // Drop the optimistic copy and surface why.
      setMessages((prev) => prev.filter((m) => m.id !== pendingId));
      setError(cause instanceof Error ? cause.message : "Could not send that message.");
    }
  }

  const rows = useMemo(() => {
    return messages.map((message, index) => {
      const prev = messages[index - 1];
      const grouped =
        prev != null &&
        prev.userId === message.userId &&
        message.createdAt - prev.createdAt < 5 * 60_000;
      return { message, grouped };
    });
  }, [messages]);

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-vs-editor">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-vs-border px-4">
        {conversation?.kind === "channel" ? (
          <span className="text-vs-muted">{conversation.visibility === "private" ? "🔒" : "#"}</span>
        ) : null}
        <h2 className="min-w-0 truncate font-display text-[15px] font-semibold tracking-tight">
          {conversation?.name ?? "…"}
        </h2>
        {conversation && conversation.kind === "channel" && (
          <span className="flex items-center gap-1 text-[12px] text-vs-muted">
            <UsersIcon className="h-3.5 w-3.5" />
            {conversation.members.length}
          </span>
        )}
        {conversation?.topic && (
          <span className="min-w-0 truncate border-l border-vs-border pl-2 text-[13px] text-vs-muted">
            {conversation.topic}
          </span>
        )}
        <span
          className={`ml-auto h-1.5 w-1.5 rounded-full ${live ? "bg-vs-success" : "bg-vs-muted/40"}`}
          title={live ? "Live" : "Reconnecting…"}
        />
      </header>

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="vs-scroll flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-4 py-3"
      >
        {loading ? (
          <div className="flex flex-1 items-center justify-center text-vs-muted">
            <SpinnerIcon className="h-5 w-5" />
          </div>
        ) : error ? (
          <div className="flex flex-1 items-center justify-center px-6 text-center text-[14px] text-vs-danger">
            {error}
          </div>
        ) : messages.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-1 text-center text-vs-muted">
            <p className="text-[15px] font-medium text-vs-fg">
              {conversation?.kind === "dm"
                ? `This is the start of your conversation with ${conversation.name}.`
                : `Welcome to ${conversation ? (conversation.kind === "channel" ? "#" : "") : ""}${conversation?.name ?? ""}`}
            </p>
            <p className="text-[13px]">Say hello 👋</p>
          </div>
        ) : (
          <>
            {hasMore && (
              <div className="flex justify-center py-2">
                <button
                  type="button"
                  onClick={loadEarlier}
                  disabled={loadingMore}
                  className="rounded-full border border-vs-border px-3 py-1 text-[12px] text-vs-muted transition hover:bg-vs-hover hover:text-vs-fg disabled:opacity-60"
                >
                  {loadingMore ? "Loading…" : "Load earlier messages"}
                </button>
              </div>
            )}
            {rows.map(({ message, grouped }) => (
              <article
                key={message.id}
                className={`flex gap-3 rounded-md px-2 hover:bg-vs-hover/40 ${grouped ? "py-0" : "pt-2"} ${
                  message.id.startsWith("pending-") ? "opacity-60" : ""
                }`}
              >
                <div className="w-9 shrink-0">
                  {!grouped && <Avatar userId={message.userId} name={message.userName} />}
                </div>
                <div className="min-w-0 flex-1">
                  {!grouped && (
                    <header className="flex items-baseline gap-2">
                      <span className="truncate text-[14px] font-semibold text-vs-fg">
                        {message.userName}
                      </span>
                      <span className="shrink-0 text-[11px] text-vs-muted">{clock(message.createdAt)}</span>
                    </header>
                  )}
                  <p className="whitespace-pre-wrap break-words text-[14px] leading-6 text-vs-fg/90">
                    {message.body}
                  </p>
                </div>
              </article>
            ))}
          </>
        )}
      </div>

      <Composer
        placeholder={
          conversation
            ? conversation.kind === "dm"
              ? `Message ${conversation.name}`
              : `Message #${conversation.name}`
            : "Message"
        }
        onSend={(text) => void onSend(text)}
      />
    </section>
  );
}
