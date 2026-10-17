"use client";

import { assignmentDraft } from "../../lib/tasks/composer";

import { useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import type { Member } from "../../lib/members";
import { STATUS_COLOR } from "../../lib/members";
import { FileIcon, FolderIcon, PlusIcon, SendIcon } from "../icons";
import { fileRefsFromText, fileToken, matchFiles, type MentionFile } from "../../lib/ai/file-mentions";
import type { MessageAttachment } from "../../lib/events/types";
import { ATTACHMENT_MAX_BYTES, MAX_ATTACHMENTS, PASTE_AS_FILE_CHARS, discardAttachment, formatBytes, uploadAttachment } from "../../lib/ai/attachments-client";

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
  const dimensions = size === "sm" ? "h-6 w-6 text-[11px]" : "h-8 w-8 text-[12px]";

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
                <span className="truncate text-sm font-semibold text-vs-fg">{author.name}</span>
                <span className="shrink-0 text-[11px] text-vs-muted">{message.time}</span>
              </header>
              <p className="mt-0.5 whitespace-pre-wrap break-words text-[14px] leading-5 text-vs-fg/90">
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
export type MentionPerson = { userId: string; handle: string; displayName: string };

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

const NO_FILES: MentionFile[] = [];

export type ComposerHandle = { insertPrompt: (text: string) => void };

/** A file in the composer: uploading, uploaded (has `sent`), or failed. */
type PendingAttachment = { key: string; name: string; size: number; progress: number; sent?: MessageAttachment; error?: string; cancel: AbortController };

export function Composer({
  inputRef,
  placeholder,
  disabled = false,
  onSend,
  /**
   * The room to upload attachments to. Files are uploaded as files and reach
   * the agent in its worktree (lib/ai/attachments.ts), not as prompt text.
   */
  attachTo,
  /** A larger, multi-line input — used for the AI chat where prompts are longer. */
  tall,
  /** Constrain the box and centre it, so it does not span the whole pane. */
  narrow,
  /** A toolbar rendered inside the box (e.g. provider / model / capacity chips). */
  footer,
  /** Rooms whose chats can be referenced by typing "@"; omit to disable mentions. */
  mentions,
  people = [],
  onAssignTask,
  /** Files and folders of the current repository, tagged by typing "@". */
  files = NO_FILES,
}: {
  inputRef?: Ref<ComposerHandle>;
  placeholder: string;
  disabled?: boolean;
  onSend: (text: string, refs: string[], attachments: MessageAttachment[], fileRefs: string[]) => void;
  attachTo?: string;
  tall?: boolean;
  narrow?: boolean;
  footer?: React.ReactNode;
  mentions?: MentionRoom[];
  people?: MentionPerson[];
  onAssignTask?: (person: MentionPerson, body: string) => Promise<void>;
  files?: MentionFile[];
}) {
  const attachmentInput = useRef<HTMLInputElement>(null);
  const [attachmentError, setAttachmentError] = useState("");
  const [attached, setAttached] = useState<PendingAttachment[]>([]);
  const readingAttachment = attached.some((file) => !file.sent && !file.error);
  const [dragging, setDragging] = useState(false);
  const [draft, setDraft] = useState("");
  const [mention, setMention] = useState<MentionState | null>(null);
  const [highlight, setHighlight] = useState(0);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const caretRef = useRef(0);
  const [pendingCaret, setPendingCaret] = useState<number | null>(null);
  const [selectedPerson, setSelectedPerson] = useState<MentionPerson | null>(null);
  const [assigning, setAssigning] = useState(false);
  const [taskMessage, setTaskMessage] = useState("");
  const [taskError, setTaskError] = useState("");
  const assignmentBusy = useRef(false);
  const assignment = selectedPerson ? assignmentDraft(draft, selectedPerson.handle) : null;
  const assignee = onAssignTask && assignment ? selectedPerson : null;
  const taskBody = assignment?.body ?? "";

  useImperativeHandle(inputRef, () => ({
    insertPrompt(text) {
      const next = draft.trim() ? `${draft}\n\n${text}` : text;
      setDraft(next);
      setMention(null);
      setPendingCaret(next.length);
    },
  }), [draft]);

  const rooms = useMemo(() => mentions ?? [], [mentions]);
  const mentionsOn = rooms.length > 0 || files.length > 0 || (!!onAssignTask && people.length > 0);

  // Restore the caret after a programmatic insert (React reset it on re-render).
  useEffect(() => {
    if (pendingCaret == null || !taRef.current) return;
    taRef.current.focus();
    taRef.current.setSelectionRange(pendingCaret, pendingCaret);
    setPendingCaret(null);
  }, [pendingCaret, draft]);

  // The list shown in the popover for the current stage/query.
  const items = useMemo<{ id: string; label: string; sub?: string; file?: MentionFile }[]>(() => {
    if (!mention) return [];
    const q = mention.query.trim().toLowerCase();
    if (mention.stage === "room") {
      return [...(onAssignTask ? people.filter(person => `${person.handle} ${person.displayName}`.toLowerCase().includes(q))
        .map(person => ({ id: `person:${person.userId}`, label: `@${person.handle} · ${person.displayName}`, sub: "Assign task" })) : []),
      ...matchFiles(files, mention.query, q ? 30 : 8).map(file => ({ id: `file:${file.path}`, label: file.path, sub: file.dir ? "Folder" : "File", file })),
      ...rooms
        .filter((room) => room.name.toLowerCase().includes(q))
        .map((room) => ({ id: room.sessionId, label: room.name, sub: `Chat reference · ${room.chats.length}` }))];
    }
    const room = rooms.find((r) => r.sessionId === mention.roomId);
    return (room?.chats ?? [])
      .filter((chat) => chat.title.toLowerCase().includes(q))
      .map((chat) => ({ id: chat.runId, label: chat.title }));
  }, [mention, rooms, people, onAssignTask, files]);

  // Show the popover whenever there's a live mention with something to show —
  // and in chat stage even with zero chats, so an empty room reads "No chats
  // yet" rather than the popover vanishing.
  const popoverOpen =
    mentionsOn && mention != null && (items.length > 0 || mention.stage === "chat");

  /** Recompute the mention state from the textarea's current text + caret. */
  function syncMention(text: string, caret: number) {
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
      } else if (files.length && !m.frag.match(RUN_ID_RE)) {
        // A path such as @app/lib/ — keep searching files.
        setMention({ stage: "room", at: m.at, query: m.frag });
        setHighlight(0);
      } else {
        setMention(null);
      }
      return;
    }
    // Keep the typed fragment while recipients are still loading. The derived
    // item list controls visibility, so late results can open the picker without
    // another keystroke, and unmatched text still leaves the popover closed.
    setMention({ stage: "room", at: m.at, query: m.frag });
    setHighlight(0);
  }

  function onDraftChange(text: string, caret: number) {
    caretRef.current = caret;
    // Removing the target cancels selection; typing that handle in a later
    // message must not silently turn the new message into an assignment.
    if (selectedPerson && !assignmentDraft(text, selectedPerson.handle)) setSelectedPerson(null);
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
    if (id.startsWith("file:")) {
      const file = files.find((item) => `file:${item.path}` === id);
      if (!file) return;
      applyInsert(`${fileToken(file)} `);
      setMention(null);
      return;
    }
    if (id.startsWith("person:")) {
      const person = people.find(person => `person:${person.userId}` === id);
      if (!person || !onAssignTask) return;
      applyInsert(`@${person.handle} `);
      setSelectedPerson(person); setMention(null); setTaskMessage(""); setTaskError("");
      return;
    }
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

  function attachFiles(files: File[]) {
    if (!attachTo || !files.length) return;
    setAttachmentError("");
    const room = MAX_ATTACHMENTS - attached.length;
    if (files.length > room) setAttachmentError(`Attach up to ${MAX_ATTACHMENTS} files to a message.`);
    for (const file of files.slice(0, Math.max(0, room))) {
      const key = crypto.randomUUID();
      if (file.size > ATTACHMENT_MAX_BYTES) {
        setAttachmentError(`${file.name} is larger than ${formatBytes(ATTACHMENT_MAX_BYTES)}. Attach a smaller file, or put it in the repository.`);
        continue;
      }
      const cancel = new AbortController();
      setAttached((list) => [...list, { key, name: file.name, size: file.size, progress: 0, cancel }]);
      const update = (patch: Partial<PendingAttachment>) => setAttached((list) => list.map((item) => (item.key === key ? { ...item, ...patch } : item)));
      uploadAttachment(attachTo, file, (progress) => update({ progress }), cancel.signal)
        .then((sent) => update({ sent, progress: 1 }))
        .catch((cause) => { if (!cancel.signal.aborted) update({ error: cause instanceof Error ? cause.message : "Upload failed." }); });
    }
  }
  function removeAttachment(key: string) {
    setAttached((list) => {
      const item = list.find((file) => file.key === key);
      item?.cancel.abort();
      if (item?.sent && attachTo) discardAttachment(attachTo, item.sent.id);
      return list.filter((file) => file.key !== key);
    });
  }
  /** Long pastes become a text attachment, so the message stays readable and small. */
  function onPaste(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    if (!attachTo) return;
    const files = Array.from(event.clipboardData.files);
    if (files.length) { event.preventDefault(); attachFiles(files); return; }
    const text = event.clipboardData.getData("text/plain");
    if (text.length < PASTE_AS_FILE_CHARS) return;
    event.preventDefault();
    const pasted = attached.filter((file) => file.name.startsWith("Pasted text")).length + 1;
    attachFiles([new File([text], `Pasted text ${pasted}.txt`, { type: "text/plain" })]);
  }

  async function send() {
    if (readingAttachment) return;
    if (assignmentBusy.current) return;
    if (assignee && onAssignTask) {
      if (!taskBody) return;
      assignmentBusy.current = true; setAssigning(true); setTaskError(""); setTaskMessage("");
      try {
        await onAssignTask(assignee, taskBody);
        setTaskMessage(`Task assigned to ${assignee.displayName}.`);
        setDraft(""); setSelectedPerson(null); setMention(null);
      } catch (cause) { setTaskError(cause instanceof Error ? cause.message : "Could not assign task. Your message is saved here; try again."); }
      finally { assignmentBusy.current = false; setAssigning(false); }
      return;
    }
    if (disabled) return;
    const text = draft.trim();
    const sent = attached.flatMap((file) => (file.sent ? [file.sent] : []));
    if (!text && !sent.length) return;
    if (attached.some((file) => file.error)) { setAttachmentError("Remove the files that failed to upload, or attach them again."); return; }
    onSend(text, refsFromText(text), sent, fileRefsFromText(text, files));
    setAttached([]);
    setAttachmentError("");
    setDraft("");
    setSelectedPerson(null);
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
    <div className="absolute bottom-full left-0 z-20 mb-2 w-96 max-w-full overflow-hidden rounded-xl border border-vs-border bg-vs-panel shadow-xl">
      <div className="border-b border-vs-border px-2.5 py-1.5 text-[11px] uppercase tracking-wider text-vs-muted">
        {mention?.stage === "room" ? (files.length ? (onAssignTask ? "Files, people & chat references" : "Files & chat references") : onAssignTask ? "People & chat references" : "Reference a room") : "Pick a chat"}
      </div>
      {items.length === 0 ? (
        <p className="px-2.5 py-2 text-[12px] text-vs-muted">No chats yet in this room.</p>
      ) : (
      <ul className="vs-scroll max-h-56 overflow-y-auto py-1">
        {items.map((item, index) => (
          <li key={item.id}>
            <button
              type="button"
              onMouseDown={(event) => {
                event.preventDefault();
              }}
              onClick={() => pick(item.id)}
              onMouseEnter={() => setHighlight(index)}
              className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[13px] ${
                index === highlight ? "bg-vs-hover text-vs-fg" : "text-vs-fg/90"
              }`}
            >
              {item.file && (item.file.dir ? <FolderIcon className="h-3.5 w-3.5 shrink-0 text-vs-muted" /> : <FileIcon className="h-3.5 w-3.5 shrink-0 text-vs-muted" />)}
              <span className="min-w-0 flex-1 truncate" dir={item.file ? "rtl" : undefined} title={item.label}>{item.file ? <bdi>{item.label}</bdi> : item.label}</span>
              {item.sub && <span className="shrink-0 text-[11px] text-vs-muted">{item.sub}</span>}
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
      onPaste={onPaste}
      disabled={assigning}
      rows={tall ? 4 : 1}
      placeholder={placeholder}
      className={`vs-scroll flex-1 resize-none bg-transparent text-[12px] text-vs-fg outline-none placeholder:text-vs-muted ${
        tall ? "max-h-64 min-h-24" : "max-h-28 min-h-5"
      }`}
    />
  );

  const sendButton = (
    <button
      type="button"
      onClick={send}
      disabled={readingAttachment || assigning || (assignee ? !taskBody : disabled || (draft.trim().length === 0 && !attached.some((file) => file.sent)))}
      aria-label={assignee ? "Assign task" : "Send message"}
      className={`flex h-7 shrink-0 items-center justify-center rounded-lg bg-vs-accent text-vs-accent-fg transition hover:opacity-90 disabled:opacity-30 ${assignee ? "px-3 text-xs font-medium" : "w-7"}`}
    >
      {assignee ? (assigning ? "Assigning…" : "Assign task") : <SendIcon className="h-3.5 w-3.5" />}
    </button>
  );

  return (
    <div className="ai-composer shrink-0">
      <div className={`relative ${narrow ? "mx-auto w-full max-w-4xl" : ""}`}>
        {assignee && <div className="mb-2 flex items-center gap-2 text-xs text-vs-muted"><span>Task for <strong className="text-vs-fg">@{assignee.handle}</strong> · appears in their task inbox</span><button type="button" disabled={assigning} className="ml-auto underline" onClick={() => setSelectedPerson(null)}>Cancel assignment</button></div>}
        {taskMessage && <p role="status" className="mb-2 text-xs text-vs-success">{taskMessage}</p>}
        {taskError && <p role="alert" className="mb-2 text-xs text-vs-danger">{taskError}</p>}
        {attachmentError && <p role="alert" className="mb-2 text-xs text-vs-danger">{attachmentError}</p>}
        {attachTo && <input ref={attachmentInput} type="file" multiple className="hidden" aria-label="Attach files" onChange={event => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          attachFiles(files);
        }} />}
        {popover}
        {footer ? (
          <div
            className={`rounded-2xl border bg-vs-panel px-4 py-3 shadow-sm focus-within:border-vs-accent ${dragging ? "border-vs-accent" : "border-vs-border"}`}
            onDragOver={attachTo ? (event) => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); event.stopPropagation(); setDragging(true); } } : undefined}
            onDragLeave={attachTo ? () => setDragging(false) : undefined}
            onDrop={attachTo ? (event) => { if (!event.dataTransfer.files.length) return; event.preventDefault(); event.stopPropagation(); setDragging(false); attachFiles(Array.from(event.dataTransfer.files)); } : undefined}
          >
            {attached.length > 0 && (
              <ul aria-label="Attached files" className="mb-2 flex flex-wrap gap-1.5">
                {attached.map((file) => (
                  <li key={file.key} className={`flex max-w-full items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px] ${file.error ? "border-vs-danger text-vs-danger" : "border-vs-border text-vs-fg"}`} title={file.error ?? file.name}>
                    <span className="max-w-48 truncate">{file.name}</span>
                    <span className="shrink-0 text-vs-muted">{file.error ? "failed" : file.sent ? formatBytes(file.size) : `${Math.round(file.progress * 100)}%`}</span>
                    <button type="button" aria-label={`Remove ${file.name}`} onClick={() => removeAttachment(file.key)} className="shrink-0 rounded px-0.5 text-vs-muted hover:text-vs-fg">×</button>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex">{textarea}</div>
            <div className="ai-composer-footer mt-3 flex items-center gap-1 border-t border-vs-border pt-2">
              {footer}
              {attachTo && <button type="button" title={`Attach files: code, logs, documents, images (up to ${formatBytes(ATTACHMENT_MAX_BYTES)} each)`} aria-label="Attach files" disabled={assigning || attached.length >= MAX_ATTACHMENTS} onClick={() => attachmentInput.current?.click()} className="ml-auto rounded p-1.5 text-vs-muted hover:bg-vs-hover"><PlusIcon className="h-4 w-4" /></button>}
              <div className="shrink-0 self-end">{sendButton}</div>
            </div>
          </div>
        ) : (
          <div className="flex items-end gap-3 rounded-2xl border border-vs-border bg-vs-panel px-4 py-3 shadow-sm focus-within:border-vs-accent">
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
