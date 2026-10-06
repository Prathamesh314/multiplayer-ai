"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
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
import { CloseIcon, SearchIcon, ShieldIcon, SpinnerIcon, UsersIcon } from "../icons";
import { ConversationComposer } from "./ConversationComposer";
import styles from "./chat.module.css";

function subscribeToWideLayout(onChange: () => void) {
  const query = window.matchMedia("(min-width: 1100px)");
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** A round, deterministically-coloured avatar for a chat author. */
function Avatar({ userId, name }: { userId: string; name: string }) {
  const color = colorOf(userId);
  return (
    <span
      className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[15px] font-semibold ${color.chip}`}
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
  const wideLayout = useSyncExternalStore(subscribeToWideLayout, () => window.matchMedia("(min-width: 1100px)").matches, () => false);
  const [memberPreference, setShowMembers] = useState<boolean | null>(null);
  const showMembers = memberPreference ?? wideLayout;
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");

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
        setMessages(prev => prev.reduce(withMessage, page.messages));
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
    let cancelled = false;
    let refreshing = false;
    let again = false;
    // Streams are notifications, not durable history. Recover missed messages
    // after reconnect, and collapse repeated reconnect signals into one read.
    const refresh = async () => {
      if (refreshing) { again = true; return; }
      refreshing = true;
      try {
        do {
          again = false;
          const page = await fetchChatMessages(conversationId);
          if (cancelled) return;
          setMessages(prev => prev.filter(message => message.id.startsWith("pending-") ||
            message.createdAt >= (page.messages[0]?.createdAt ?? Infinity)).reduce(withMessage, page.messages));
          setHasMore(page.hasMore);
        } while (again && !cancelled);
      } catch { /* A disconnected stream retries; keep already loaded history. */ }
      finally { refreshing = false; }
    };
    const stream = openChatStream(conversationId, {
      onStatus: setLive,
      onResync: () => { void refresh(); },
      onMessage: (event) => {
        if (event.conversationId !== conversationId) return;
        setMessages((prev) => withMessage(prev, event.message));
        if (event.message.userId !== me.id) {
          void markConversationRead(conversationId);
          onRead?.();
        }
      },
    });
    return () => { cancelled = true; stream.close(); };
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
    setError(null);
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
      throw cause;
    }
  }

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const visible = needle
      ? messages.filter((message) => `${message.userName} ${message.body}`.toLowerCase().includes(needle))
      : messages;
    return visible.map((message, index) => {
      const prev = visible[index - 1];
      const day = new Date(message.createdAt).toDateString();
      const startsDay = !prev || new Date(prev.createdAt).toDateString() !== day;
      const grouped = !startsDay && prev.userId === message.userId && message.createdAt - prev.createdAt < 5 * 60_000;
      return { message, grouped, startsDay };
    });
  }, [messages, search]);

  const channelName = conversation?.kind === "channel" ? `#${conversation.name}` : conversation?.name ?? "conversation";

  return (
    <section className={styles.conversation} aria-label={channelName}>
      <header className={styles.conversationHeader}>
        <span className={styles.channelSymbol} aria-hidden="true">
          {conversation?.visibility === "private" && conversation.kind === "channel" ? <ShieldIcon /> : conversation?.kind === "dm" ? "@" : "#"}
        </span>
        <h2>{conversation?.name ?? "Opening conversation…"}</h2>
        {conversation?.topic && <p className={styles.topic} title={conversation.topic}>{conversation.topic}</p>}
        <div className={styles.headerActions}>
          <span className={`${styles.connection} ${live ? styles.connected : ""}`} title={live ? "Connected to live messages" : "Reconnecting to live messages"} aria-label={live ? "Connected to live messages" : "Reconnecting to live messages"} />
          <button type="button" className={styles.iconButton} aria-label="Search messages" aria-expanded={searchOpen} aria-controls="conversation-search" onClick={() => { setSearchOpen((value) => !value); setSearch(""); }}><SearchIcon /></button>
          <button type="button" className={styles.iconButton} aria-label="Toggle member list" aria-expanded={showMembers} aria-controls="conversation-members" onClick={() => setShowMembers(!showMembers)}><UsersIcon /></button>
        </div>
      </header>

      {searchOpen && (
        <div id="conversation-search" className={styles.searchBar}>
          <SearchIcon />
          <input autoFocus type="search" aria-label="Search loaded messages" placeholder={`Search loaded messages in ${channelName}`} value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { setSearchOpen(false); setSearch(""); } }} />
          <span role="status">{rows.length} messages</span>
          <button type="button" className={styles.iconButton} aria-label="Close message search" onClick={() => { setSearchOpen(false); setSearch(""); }}><CloseIcon /></button>
        </div>
      )}

      <div className={styles.conversationBody}>
        <div className={styles.messageColumn}>
          <div ref={scrollRef} onScroll={onScroll} className={`${styles.timeline} vs-scroll`} aria-busy={loading}>
            {loading ? (
              <div className={styles.loading} role="status"><SpinnerIcon className="h-5 w-5" /> Loading conversation…</div>
            ) : !conversation ? (
              <p className={styles.error} role="alert">{error ?? "Could not open this conversation."}</p>
            ) : (
              <>
                {!hasMore && !search && (
                  <div className={styles.channelWelcome}>
                    <span aria-hidden="true">{conversation.kind === "channel" ? "#" : "@"}</span>
                    <h3>{conversation.kind === "channel" ? `Welcome to #${conversation.name}` : conversation.name}</h3>
                    <p>{conversation.topic ?? (conversation.kind === "channel" ? "This is the beginning of your team’s conversation. Share an update, ask a question, or start something together." : `This is the start of your conversation with ${conversation.name}.`)}</p>
                  </div>
                )}
                {hasMore && (
                  <button type="button" onClick={loadEarlier} disabled={loadingMore} className={styles.loadEarlier}>
                    {loadingMore ? "Loading…" : "Load earlier messages"}
                  </button>
                )}
                {search && rows.length === 0 && <p className={styles.noResults}>No loaded messages match “{search}”.</p>}
                {rows.map(({ message, grouped, startsDay }) => (
                  <Fragment key={message.id}>
                    {startsDay && <div className={styles.dateDivider}><time dateTime={new Date(message.createdAt).toISOString()}>{new Date(message.createdAt).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })}</time></div>}
                    <article className={`${styles.message} ${grouped ? styles.groupedMessage : ""} ${message.id.startsWith("pending-") ? styles.pendingMessage : ""} ${message.body.split(/\s+/).some(word => word.replace(/[.,!?;:]$/, "").toLowerCase() === `@${me.handle.toLowerCase()}`) ? styles.mentionedMessage : ""}`}>
                      <div className={styles.messageAvatar}>
                        {!grouped ? <Avatar userId={message.userId} name={message.userName} /> : <time className={styles.groupedTime} dateTime={new Date(message.createdAt).toISOString()}>{clock(message.createdAt)}</time>}
                      </div>
                      <div className={styles.messageContent}>
                        {!grouped && (
                          <header>
                            <span className={colorOf(message.userId).text}>{message.userName}</span>
                            <time dateTime={new Date(message.createdAt).toISOString()} title={new Date(message.createdAt).toLocaleString()}>{clock(message.createdAt)}</time>
                            {message.id.startsWith("pending-") && <small>Sending…</small>}
                          </header>
                        )}
                        <p>{message.body.split(/(@[a-zA-Z0-9_-]+)/g).map((part, index) => part.startsWith("@") ? <mark key={index}>{part}</mark> : part)}</p>
                      </div>
                    </article>
                  </Fragment>
                ))}
              </>
            )}
          </div>
          {error && conversation && <p role="alert" className={styles.sendError}>{error} Your message is still in the composer.</p>}
          <ConversationComposer name={channelName} disabled={loading || !conversation} onSend={onSend} />
        </div>

        {showMembers && conversation && (
          <aside id="conversation-members" className={styles.memberList} aria-label="Conversation members">
            <div className={styles.memberListHeading}><h3>Members — {conversation.members.length}</h3><button type="button" className={styles.iconButton} aria-label="Close member list" onClick={() => setShowMembers(false)}><CloseIcon /></button></div>
            <ul>{conversation.members.map((member) => (
              <li key={member.userId}>
                <Avatar userId={member.userId} name={member.displayName} />
                <div><span>{member.displayName}{member.userId === me.id && <small> (you)</small>}</span><p>@{member.handle}</p></div>
                {member.role === "owner" && <span className={styles.ownerBadge} title="Channel owner"><ShieldIcon className="h-3.5 w-3.5" /></span>}
              </li>
            ))}</ul>
            {conversation.members.length === 0 && <p className={styles.memberNote}>Send a message to join this channel.</p>}
          </aside>
        )}
      </div>
    </section>
  );
}
