"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createConversation, listConversations } from "../../lib/chat/client";
import type { ConversationSummary, ConversationVisibility } from "../../lib/chat/types";
import { fetchOrgMembers } from "../../lib/org/client";
import type { Org, OrgMember } from "../../lib/org/types";
import { colorOf, initialsOf } from "../../lib/people";
import { CheckIcon, ChevronIcon, PlusIcon, ShieldIcon, SpinnerIcon } from "../icons";
import { ErrorNote, Field, GhostButton, inputClass, Modal, PrimaryButton } from "../ui/Modal";

import styles from "./chat.module.css";

type Dialog = { kind: "channel" } | { kind: "dm" } | null;

export function ChatSection({
  org,
  meId,
  activeConversationId,
  version,
  onOpen,
  onChanged,
}: {
  org: Org;
  meId: string;
  activeConversationId: string | null;
  /** Bumped by the parent to force a reload (e.g. after reading a conversation). */
  version: number;
  onOpen: (id: string) => void;
  onChanged: () => void;
}) {
  const [conversations, setConversations] = useState<ConversationSummary[] | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);

  const reload = useCallback(async () => {
    try {
      setConversations(await listConversations(org.slug));
    } catch {
      setConversations([]);
    }
  }, [org.slug]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await listConversations(org.slug);
        if (!cancelled) setConversations(list);
      } catch {
        if (!cancelled) setConversations([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [org.slug, version]);

  const channels = useMemo(
    () => (conversations ?? []).filter((c) => c.kind === "channel"),
    [conversations],
  );
  const dms = useMemo(() => (conversations ?? []).filter((c) => c.kind === "dm"), [conversations]);

  async function afterCreate(id: string) {
    setDialog(null);
    onOpen(id);
    await reload();
    onChanged();
  }

  return (
    <>
      <Group
        title="Channels"
        onAdd={() => setDialog({ kind: "channel" })}
        addTitle="Create a channel"
      >
        {conversations === null ? (
          <Loading />
        ) : channels.length === 0 ? (
          <Empty text="No channels yet." />
        ) : (
          channels.map((c) => (
            <ConversationRow
              key={c.id}
              conversation={c}
              active={c.id === activeConversationId}
              onClick={() => onOpen(c.id)}
            />
          ))
        )}
      </Group>

      <Group title="Direct Messages" onAdd={() => setDialog({ kind: "dm" })} addTitle="New message">
        {conversations === null ? (
          <Loading />
        ) : dms.length === 0 ? (
          <Empty text="No direct messages yet." />
        ) : (
          dms.map((c) => (
            <ConversationRow
              key={c.id}
              conversation={c}
              active={c.id === activeConversationId}
              onClick={() => onOpen(c.id)}
            />
          ))
        )}
      </Group>

      {dialog?.kind === "channel" && (
        <NewChannelDialog org={org} meId={meId} onClose={() => setDialog(null)} onCreated={afterCreate} />
      )}
      {dialog?.kind === "dm" && (
        <NewDmDialog org={org} meId={meId} onClose={() => setDialog(null)} onCreated={afterCreate} />
      )}
    </>
  );
}

function Group({
  title,
  addTitle,
  onAdd,
  children,
}: {
  title: string;
  addTitle: string;
  onAdd: () => void;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className={styles.channelGroup}>
      <div className={styles.groupHeading}>
        <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          <ChevronIcon className={`h-3 w-3 transition-transform ${open ? "rotate-90" : ""}`} />
          {title}
        </button>
        <button type="button" onClick={onAdd} title={addTitle} aria-label={addTitle} className={styles.iconButton}>
          <PlusIcon className="h-3.5 w-3.5" />
        </button>
      </div>
      {open && <ul className="space-y-0.5 px-2">{children}</ul>}
    </div>
  );
}

function Loading() {
  return (
    <li className="flex items-center gap-2 px-2 py-1.5 text-ui text-vs-muted">
      <SpinnerIcon className="h-3.5 w-3.5" /> Loading…
    </li>
  );
}

function Empty({ text }: { text: string }) {
  return <li className="px-2 py-1 text-chrome text-vs-muted">{text}</li>;
}

function ConversationRow({
  conversation,
  active,
  onClick,
}: {
  conversation: ConversationSummary;
  active: boolean;
  onClick: () => void;
}) {
  const unread = conversation.unread > 0;
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        aria-current={active ? "page" : undefined}
        className={styles.channelRow}
      >
        {conversation.kind === "dm" ? (
          <span
            className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-micro font-semibold ${colorOf(conversation.otherUserId ?? conversation.id).chip}`}
          >
            {initialsOf(conversation.name)}
          </span>
        ) : conversation.visibility === "private" ? (
          <ShieldIcon className="h-3.5 w-3.5 shrink-0 text-vs-muted" />
        ) : (
          <span className={styles.channelHash}>#</span>
        )}
        <span className={`min-w-0 flex-1 truncate ${unread ? "font-semibold text-vs-fg" : ""}`}>
          {conversation.name}
        </span>
        {unread && (
          <span className={styles.channelUnread}>
            {conversation.unread > 99 ? "99+" : conversation.unread}
          </span>
        )}
      </button>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

function NewChannelDialog({
  org,
  meId,
  onClose,
  onCreated,
}: {
  org: Org;
  meId: string;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [visibility, setVisibility] = useState<ConversationVisibility>("public");
  const [members, setMembers] = useState<OrgMember[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (visibility !== "private" || members !== null) return;
    void fetchOrgMembers(org.slug)
      .then(setMembers)
      .catch(() => setMembers([]));
  }, [visibility, members, org.slug]);

  async function create() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Name the channel first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const conversation = await createConversation({
        orgSlug: org.slug,
        kind: "channel",
        name: trimmed,
        visibility,
        memberIds: visibility === "private" ? [...selected] : undefined,
      });
      onCreated(conversation.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create the channel.");
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Create a channel"
      description="Channels are for team conversations. Public channels are open to everyone in the organisation."
      onClose={onClose}
      footer={
        <>
          <GhostButton onClick={onClose}>Cancel</GhostButton>
          <PrimaryButton onClick={create} disabled={busy}>
            {busy ? "Creating…" : "Create channel"}
          </PrimaryButton>
        </>
      }
    >
      {error && <ErrorNote>{error}</ErrorNote>}
      <Field label="Channel name">
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void create()}
          placeholder="e.g. general"
          maxLength={80}
          className={inputClass}
        />
      </Field>

      <div className="flex gap-2">
        <VisibilityOption
          label="Public"
          hint="Everyone in the org"
          active={visibility === "public"}
          onClick={() => setVisibility("public")}
        />
        <VisibilityOption
          label="Private"
          hint="Only invited members"
          active={visibility === "private"}
          onClick={() => setVisibility("private")}
        />
      </div>

      {visibility === "private" && (
        <Field label="Members">
          <div className="mt-1.5 max-h-48 space-y-0.5 overflow-y-auto rounded-lg border border-vs-border vs-scroll">
            {members === null ? (
              <p className="px-3 py-2 text-ui text-vs-muted">Loading members…</p>
            ) : (
              members
                .filter((m) => m.userId !== meId)
                .map((m) => {
                  const on = selected.has(m.userId);
                  return (
                    <button
                      key={m.userId}
                      type="button"
                      onClick={() =>
                        setSelected((prev) => {
                          const next = new Set(prev);
                          if (next.has(m.userId)) next.delete(m.userId);
                          else next.add(m.userId);
                          return next;
                        })
                      }
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-body transition hover:bg-vs-hover"
                    >
                      <span
                        className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-micro font-semibold ${colorOf(m.userId).chip}`}
                      >
                        {initialsOf(m.displayName)}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{m.displayName}</span>
                      {on && <CheckIcon className="h-4 w-4 text-vs-accent" />}
                    </button>
                  );
                })
            )}
          </div>
        </Field>
      )}
    </Modal>
  );
}

function VisibilityOption({
  label,
  hint,
  active,
  onClick,
}: {
  label: string;
  hint: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-1 rounded-lg border px-3 py-2 text-left transition ${
        active ? "border-vs-accent bg-vs-accent/10" : "border-vs-border hover:bg-vs-hover"
      }`}
    >
      <span className="block text-body font-medium text-vs-fg">{label}</span>
      <span className="block text-chrome text-vs-muted">{hint}</span>
    </button>
  );
}

function NewDmDialog({
  org,
  meId,
  onClose,
  onCreated,
}: {
  org: Org;
  meId: string;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [members, setMembers] = useState<OrgMember[] | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void fetchOrgMembers(org.slug)
      .then(setMembers)
      .catch(() => setMembers([]));
  }, [org.slug]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (members ?? [])
      .filter((m) => m.userId !== meId)
      .filter((m) => !q || m.displayName.toLowerCase().includes(q) || m.handle.toLowerCase().includes(q));
  }, [members, meId, query]);

  async function open(userId: string) {
    setBusy(true);
    setError(null);
    try {
      const conversation = await createConversation({ orgSlug: org.slug, kind: "dm", userId });
      onCreated(conversation.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not open that conversation.");
      setBusy(false);
    }
  }

  return (
    <Modal title="New message" description="Start a direct message with a teammate." onClose={onClose}>
      {error && <ErrorNote>{error}</ErrorNote>}
      <input
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search people…"
        className={inputClass}
      />
      <div className="max-h-72 space-y-0.5 overflow-y-auto vs-scroll">
        {members === null ? (
          <p className="px-1 py-2 text-ui text-vs-muted">Loading people…</p>
        ) : results.length === 0 ? (
          <p className="px-1 py-2 text-ui text-vs-muted">No one matches.</p>
        ) : (
          results.map((m) => (
            <button
              key={m.userId}
              type="button"
              disabled={busy}
              onClick={() => void open(m.userId)}
              className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition hover:bg-vs-hover disabled:opacity-60"
            >
              <span
                className={`inline-flex h-8 w-8 items-center justify-center rounded-full text-chrome font-semibold ${colorOf(m.userId).chip}`}
              >
                {initialsOf(m.displayName)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-body text-vs-fg">{m.displayName}</span>
                <span className="block truncate text-chrome text-vs-muted">@{m.handle}</span>
              </span>
            </button>
          ))
        )}
      </div>
    </Modal>
  );
}
