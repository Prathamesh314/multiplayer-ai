"use client";

import { useMemo, useState } from "react";
import type { AgentRun } from "../../lib/ai/runs";
import { archiveRun, renameRun } from "../../lib/ai/runs-client";
import { relativeTime } from "../../lib/format";
import { colorOf, initialsOf } from "../../lib/people";
import type { ChatMessage, SessionMember } from "../../lib/session/types";
import { CheckIcon, ChevronIcon, GitBranchIcon, LinkIcon, PlusIcon, SpinnerIcon } from "../icons";
import { TeamChatPanel } from "./TeamChatPanel";

type RoomSidebarProps = {
  sessionId: string;
  /** This room's name, for building copyable `@room/<run-id>` chat paths. */
  roomName: string;
  members: SessionMember[];
  /** The signed-in user's id, for marking their own folder. */
  myUserId: string | null;
  incoming: ChatMessage[];
  runs: AgentRun[];
  enteredRunId: string | null;
  onEnter: (run: AgentRun) => void;
  onNewRun: () => void;
  onFork: (run: AgentRun) => void;
  /** Reload the runs after one is renamed. */
  onRenamed: () => void;
};

/**
 * The room's people column: the team chat and the agent runs, each a
 * collapsible section. Runs are browsed by team member — a tab per person,
 * their sessions beneath it — and entering one opens it in the main chat.
 */
export function RoomSidebar({
  sessionId,
  roomName,
  members,
  myUserId,
  incoming,
  runs,
  enteredRunId,
  onEnter,
  onNewRun,
  onFork,
  onRenamed,
}: RoomSidebarProps) {
  // Chat is hidden for now; flip to re-enable the team-chat section.
  const SHOW_CHAT = false;
  const [chatOpen, setChatOpen] = useState(true);
  const [runsOpen, setRunsOpen] = useState(true);

  return (
    <aside className="flex h-full min-h-0 w-full flex-col bg-vs-panel">
      {SHOW_CHAT && (
        <>
          <SectionHeader title="Chat" open={chatOpen} onToggle={() => setChatOpen((v) => !v)} />
          {chatOpen && (
            <div className="flex min-h-0 flex-1 flex-col border-b border-vs-border">
              <TeamChatPanel sessionId={sessionId} members={members} incoming={incoming} embedded />
            </div>
          )}
        </>
      )}

      <SectionHeader
        title="Agent runs"
        count={runs.filter((run) => !run.archivedAt).length}
        open={runsOpen}
        onToggle={() => setRunsOpen((v) => !v)}
      />
      {runsOpen && (
        <div className="flex min-h-0 flex-1 flex-col">
          <AgentRunsBrowser
            sessionId={sessionId}
            roomName={roomName}
            members={members}
            myUserId={myUserId}
            runs={runs}
            enteredRunId={enteredRunId}
            onEnter={onEnter}
            onNewRun={onNewRun}
            onFork={onFork}
            onRenamed={onRenamed}
          />
        </div>
      )}
    </aside>
  );
}

function SectionHeader({
  title,
  count,
  open,
  onToggle,
  action,
}: {
  title: string;
  count?: number;
  open: boolean;
  onToggle: () => void;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex h-8 shrink-0 items-center gap-1 border-b border-vs-border bg-vs-chrome px-2">
      <button
        type="button"
        onClick={onToggle}
        className="flex flex-1 items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-vs-muted transition hover:text-vs-fg"
      >
        <ChevronIcon className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-90" : ""}`} />
        {title}
        {count !== undefined && count > 0 && <span className="text-vs-muted/70">{count}</span>}
      </button>
      {open && action}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Runs browsed by person
// ---------------------------------------------------------------------------

type Person = { id: string; name: string; isSelf: boolean };

function AgentRunsBrowser({
  sessionId,
  roomName,
  members,
  myUserId,
  runs,
  enteredRunId,
  onEnter,
  onNewRun,
  onFork,
  onRenamed,
}: {
  sessionId: string;
  roomName: string;
  members: SessionMember[];
  myUserId: string | null;
  runs: AgentRun[];
  enteredRunId: string | null;
  onEnter: (run: AgentRun) => void;
  onNewRun: () => void;
  onFork: (run: AgentRun) => void;
  onRenamed: () => void;
}) {
  // Prefer the resolved id; fall back to the roster's isSelf flag if it hasn't
  // loaded yet. A public-room viewer has no roster row, so the flag alone misses.
  const myId = myUserId ?? members.find((member) => member.isSelf)?.userId ?? null;
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Copy an `@room/<run-id>` path to reference this chat from another room's
  // composer — the id is what the server resolves, the name is just readable.
  function copyPath(run: AgentRun) {
    const path = `@${roomName}/${run.id}`;
    void navigator.clipboard
      ?.writeText(path)
      .then(() => {
        setCopiedId(run.id);
        window.setTimeout(() => setCopiedId((id) => (id === run.id ? null : id)), 1200);
      })
      .catch(() => {});
  }
  // Folders the viewer has toggled away from their default (mine defaults open,
  // others closed). Tracking flips rather than absolute open-state means the
  // default reacts correctly once `myId` resolves, with no seeding effect.
  const [flipped, setFlipped] = useState<Set<string>>(() => new Set());
  const [archivedOpen, setArchivedOpen] = useState<Set<string>>(() => new Set());
  const isFolderOpen = (personId: string) => {
    const defaultOpen = personId === myId;
    return flipped.has(personId) ? !defaultOpen : defaultOpen;
  };

  async function commitRename(run: AgentRun) {
    const title = draft.trim();
    setEditingId(null);
    if (title && title !== run.title) {
      try {
        await renameRun(sessionId, run.id, title);
        onRenamed();
      } catch {
        // Leave the old name in place on failure.
      }
    }
  }

  async function toggleArchive(run: AgentRun, archived: boolean) {
    try {
      await archiveRun(sessionId, run.id, archived);
      onRenamed(); // refreshes the room's run list
    } catch {
      // Leave it as-is on failure.
    }
  }

  const toggle = (set: Set<string>, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  };

  // A folder for every team member, plus anyone who has run an agent but is no
  // longer in the roster. Me first, then most-recently-active.
  const people = useMemo<Person[]>(() => {
    const map = new Map<string, Person>();
    for (const member of members)
      map.set(member.userId, {
        id: member.userId,
        name: member.displayName,
        isSelf: member.userId === myId,
      });
    for (const run of runs)
      if (!map.has(run.startedBy))
        // A run-starter with no roster row is still you if the id matches — a
        // public-room viewer has no session_members row but can start runs.
        map.set(run.startedBy, {
          id: run.startedBy,
          name: run.startedByName,
          isSelf: run.startedBy === myId,
        });

    const lastRun = new Map<string, number>();
    for (const run of runs) lastRun.set(run.startedBy, Math.max(lastRun.get(run.startedBy) ?? 0, run.createdAt));

    return [...map.values()].sort(
      (a, b) =>
        Number(b.isSelf) - Number(a.isSelf) ||
        (lastRun.get(b.id) ?? 0) - (lastRun.get(a.id) ?? 0) ||
        a.name.localeCompare(b.name),
    );
  }, [members, runs, myId]);

  // Each person's chats, split into live and archived, newest first.
  const byPerson = useMemo(() => {
    const map = new Map<string, { active: AgentRun[]; archived: AgentRun[] }>();
    for (const person of people) map.set(person.id, { active: [], archived: [] });
    for (const run of runs) {
      const bucket = map.get(run.startedBy);
      if (!bucket) continue;
      (run.archivedAt ? bucket.archived : bucket.active).push(run);
    }
    for (const bucket of map.values()) {
      bucket.active.sort((a, b) => b.createdAt - a.createdAt);
      bucket.archived.sort((a, b) => b.createdAt - a.createdAt);
    }
    return map;
  }, [people, runs]);

  if (people.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-4 text-center text-[11px] text-vs-muted">
        No one has run an agent yet.
      </div>
    );
  }

  /** One chat row. `self` unlocks rename/archive; others' rows offer fork. */
  const renderRun = (run: AgentRun, self: boolean) => {
    const active = run.id === enteredRunId;
    const archived = !!run.archivedAt;

    if (editingId === run.id) {
      return (
        <div key={run.id} className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1">
          <GitBranchIcon className="h-3.5 w-3.5 shrink-0 text-vs-accent" />
          <input
            autoFocus
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => void commitRename(run)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void commitRename(run);
              } else if (event.key === "Escape") {
                setEditingId(null);
              }
            }}
            className="min-w-0 flex-1 rounded border border-vs-accent bg-vs-editor px-1.5 py-0.5 text-[12px] text-vs-fg outline-none"
          />
        </div>
      );
    }

    return (
      <div
        key={run.id}
        className={`group flex w-full min-w-0 items-center gap-1 rounded-md pr-1 transition ${
          active ? "bg-vs-accent/10" : "hover:bg-vs-hover"
        }`}
      >
        <button
          type="button"
          onClick={() => onEnter(run)}
          onDoubleClick={() => {
            if (self && !archived) {
              setDraft(run.title ?? "");
              setEditingId(run.id);
            }
          }}
          title={`${run.title ?? "Agent run"} · ${run.agentId} · ${run.status} · ${relativeTime(Math.floor(run.createdAt / 1000))}`}
          className={`flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left ${
            active ? "text-vs-accent" : archived ? "text-vs-muted" : "text-vs-fg"
          }`}
        >
          {run.status === "running" ? (
            <SpinnerIcon className="h-3.5 w-3.5 shrink-0 text-amber-500" />
          ) : (
            <GitBranchIcon
              className={`h-3.5 w-3.5 shrink-0 ${
                active
                  ? "text-vs-accent"
                  : run.status === "failed"
                    ? "text-red-500"
                    : "text-vs-muted"
              }`}
            />
          )}
          <span className="min-w-0 flex-1 truncate text-[12px]">
            {run.title ?? `${run.agentId} run`}
          </span>
          <DiffStat added={run.addedLines} removed={run.removedLines} />
        </button>

        <IconButton
          onClick={() => copyPath(run)}
          title={`Copy chat path (@${roomName}/…) to reference it from another room`}
          label="Copy chat path"
        >
          {copiedId === run.id ? (
            <CheckIcon className="h-3.5 w-3.5 text-green-500" />
          ) : (
            <LinkIcon className="h-3.5 w-3.5" />
          )}
        </IconButton>

        {self ? (
          archived ? (
            <IconButton
              onClick={() => void toggleArchive(run, false)}
              title="Restore this chat"
              label="Restore chat"
            >
              <UnarchiveIcon className="h-3.5 w-3.5" />
            </IconButton>
          ) : (
            <>
              <IconButton
                onClick={() => {
                  setDraft(run.title ?? "");
                  setEditingId(run.id);
                }}
                title="Rename"
                label="Rename chat"
              >
                <PencilIcon className="h-3.5 w-3.5" />
              </IconButton>
              <IconButton
                onClick={() => void toggleArchive(run, true)}
                title="Archive this chat"
                label="Archive chat"
              >
                <ArchiveIcon className="h-3.5 w-3.5" />
              </IconButton>
            </>
          )
        ) : (
          <IconButton
            onClick={() => onFork(run)}
            title="Fork: start a new chat that imports this chat's context"
            label="Fork this chat into a new one with its context"
          >
            <GitBranchIcon className="h-3.5 w-3.5" />
          </IconButton>
        )}
      </div>
    );
  };

  return (
    <div className="vs-scroll min-h-0 flex-1 space-y-0.5 overflow-y-auto p-1.5">
      {people.map((person) => {
        const bucket = byPerson.get(person.id) ?? { active: [], archived: [] };
        const open = isFolderOpen(person.id);
        const color = colorOf(person.id);
        return (
          <div key={person.id}>
            <button
              type="button"
              onClick={() => setFlipped((s) => toggle(s, person.id))}
              title={person.name}
              className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1.5 text-left text-vs-fg transition hover:bg-vs-hover"
            >
              <ChevronIcon className={`h-3.5 w-3.5 shrink-0 text-vs-muted transition-transform ${open ? "rotate-90" : ""}`} />
              <span
                className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold ${color.chip}`}
              >
                {initialsOf(person.name)}
              </span>
              {/* Always the person's real name, so the folder reads the same to
                  everyone; your own is marked "(you)" rather than a viewer-relative "Me". */}
              <span className={`min-w-0 flex-1 truncate text-[12px] ${person.isSelf ? "font-medium" : ""}`}>
                {person.name}
                {person.isSelf && <span className="ml-1 font-normal text-vs-muted">(you)</span>}
              </span>
              {bucket.active.length > 0 && (
                <span className="shrink-0 text-[10px] tabular-nums text-vs-muted/70">{bucket.active.length}</span>
              )}
            </button>

            {open && (
              <div className="ml-3 space-y-0.5 border-l border-vs-border pl-1.5">
                {person.isSelf && (
                  <button
                    type="button"
                    onClick={onNewRun}
                    className="flex w-full items-center gap-2 rounded-md border border-dashed border-vs-border px-2 py-1.5 text-[12px] text-vs-muted transition hover:border-vs-accent hover:text-vs-fg"
                  >
                    <PlusIcon className="h-3.5 w-3.5" />
                    New chat
                  </button>
                )}

                {bucket.active.length === 0 ? (
                  <p className="px-2 py-2 text-[11px] text-vs-muted">No chats yet.</p>
                ) : (
                  bucket.active.map((run) => renderRun(run, person.isSelf))
                )}

                {/* You manage your own archive; others' archived chats stay hidden. */}
                {person.isSelf && bucket.archived.length > 0 && (
                  <>
                    <button
                      type="button"
                      onClick={() => setArchivedOpen((s) => toggle(s, person.id))}
                      className="mt-0.5 flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[10px] font-semibold uppercase tracking-wider text-vs-muted transition hover:text-vs-fg"
                    >
                      <ChevronIcon
                        className={`h-3 w-3 shrink-0 transition-transform ${archivedOpen.has(person.id) ? "rotate-90" : ""}`}
                      />
                      Archived
                      <span className="text-vs-muted/70">{bucket.archived.length}</span>
                    </button>
                    {archivedOpen.has(person.id) &&
                      bucket.archived.map((run) => renderRun(run, person.isSelf))}
                  </>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** A hover-revealed icon action on a chat row. */
function IconButton({
  onClick,
  title,
  label,
  children,
}: {
  onClick: () => void;
  title: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={label}
      className="shrink-0 rounded p-1 text-vs-muted opacity-0 transition hover:bg-vs-hover hover:text-vs-fg group-hover:opacity-100"
    >
      {children}
    </button>
  );
}

function PencilIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden className={className}>
      <path d="M11.5 2.5a1.4 1.4 0 0 1 2 2L6 12l-3 1 1-3 7.5-7.5Z" strokeLinejoin="round" />
    </svg>
  );
}

function ArchiveIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden className={className}>
      <rect x="2" y="3" width="12" height="3" rx="0.5" />
      <path d="M3 6.5v6a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-6" strokeLinejoin="round" />
      <path d="M6.5 9h3" strokeLinecap="round" />
    </svg>
  );
}

function UnarchiveIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden className={className}>
      <rect x="2" y="3" width="12" height="3" rx="0.5" />
      <path d="M3 6.5v6a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-6" strokeLinejoin="round" />
      <path d="M8 12V8.5M8 8.5 6.5 10M8 8.5 9.5 10" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** A run's diff size, `+added -removed`, shown only when it changed something. */
function DiffStat({ added, removed }: { added: number | null; removed: number | null }) {
  if (!added && !removed) return null;
  return (
    <span className="shrink-0 font-mono text-[10px] tabular-nums">
      {added ? <span className="text-emerald-500">+{added}</span> : null}
      {removed ? <span className="ml-1 text-red-500">-{removed}</span> : null}
    </span>
  );
}
