"use client";

import { useMemo, useState } from "react";
import type { AgentRun } from "../../lib/ai/runs";
import { relativeTime } from "../../lib/format";
import { colorOf, initialsOf } from "../../lib/people";
import type { ChatMessage, SessionMember } from "../../lib/session/types";
import { ChevronIcon, GitBranchIcon, PlusIcon } from "../icons";
import { TeamChatPanel } from "./TeamChatPanel";

type RoomSidebarProps = {
  sessionId: string;
  members: SessionMember[];
  incoming: ChatMessage[];
  runs: AgentRun[];
  enteredRunId: string | null;
  onEnter: (run: AgentRun) => void;
  onNewRun: () => void;
  onFork: (run: AgentRun) => void;
};

/**
 * The room's people column: the team chat and the agent runs, each a
 * collapsible section. Runs are browsed by team member — a tab per person,
 * their sessions beneath it — and entering one opens it in the main chat.
 */
export function RoomSidebar({
  sessionId,
  members,
  incoming,
  runs,
  enteredRunId,
  onEnter,
  onNewRun,
  onFork,
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
        count={runs.length}
        open={runsOpen}
        onToggle={() => setRunsOpen((v) => !v)}
      />
      {runsOpen && (
        <div className="flex min-h-0 flex-1 flex-col">
          <AgentRunsBrowser
            members={members}
            runs={runs}
            enteredRunId={enteredRunId}
            onEnter={onEnter}
            onNewRun={onNewRun}
            onFork={onFork}
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
  members,
  runs,
  enteredRunId,
  onEnter,
  onNewRun,
  onFork,
}: {
  members: SessionMember[];
  runs: AgentRun[];
  enteredRunId: string | null;
  onEnter: (run: AgentRun) => void;
  onNewRun: () => void;
  onFork: (run: AgentRun) => void;
}) {
  const myId = members.find((member) => member.isSelf)?.userId ?? null;

  // A tab for every team member, plus anyone who has run an agent but is no
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
        map.set(run.startedBy, { id: run.startedBy, name: run.startedByName, isSelf: false });

    const lastRun = new Map<string, number>();
    for (const run of runs) lastRun.set(run.startedBy, Math.max(lastRun.get(run.startedBy) ?? 0, run.createdAt));

    return [...map.values()].sort(
      (a, b) =>
        Number(b.isSelf) - Number(a.isSelf) ||
        (lastRun.get(b.id) ?? 0) - (lastRun.get(a.id) ?? 0) ||
        a.name.localeCompare(b.name),
    );
  }, [members, runs, myId]);

  const [selected, setSelected] = useState<string | null>(null);
  const activeId = selected && people.some((p) => p.id === selected) ? selected : people[0]?.id ?? null;
  const viewingSelf = activeId != null && activeId === myId;
  const personRuns = runs
    .filter((run) => run.startedBy === activeId)
    .sort((a, b) => b.createdAt - a.createdAt);

  if (people.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-4 text-center text-[11px] text-vs-muted">
        No one has run an agent yet.
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="vs-scroll shrink-0 space-y-0.5 border-b border-vs-border p-1.5">
        {people.map((person) => {
          const active = person.id === activeId;
          const runCount = runs.filter((run) => run.startedBy === person.id).length;
          const color = colorOf(person.id);
          return (
            <button
              key={person.id}
              type="button"
              onClick={() => setSelected(person.id)}
              title={person.isSelf ? "You" : person.name}
              className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition ${
                active ? "bg-vs-accent/10 text-vs-fg" : "text-vs-muted hover:bg-vs-hover hover:text-vs-fg"
              }`}
            >
              <span
                className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ${color.chip}`}
              >
                {initialsOf(person.name)}
              </span>
              <span className={`min-w-0 flex-1 truncate text-[12px] ${person.isSelf ? "font-medium" : ""}`}>
                {person.isSelf ? "Me" : person.name}
              </span>
              {runCount > 0 && (
                <span className="shrink-0 text-[10px] tabular-nums text-vs-muted/70">{runCount}</span>
              )}
            </button>
          );
        })}
      </div>

      <div className="vs-scroll min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
        {viewingSelf && (
          <button
            type="button"
            onClick={onNewRun}
            className="mb-1 flex w-full items-center gap-2 rounded-md border border-dashed border-vs-border px-2 py-2 text-[12px] text-vs-muted transition hover:border-vs-accent hover:text-vs-fg"
          >
            <PlusIcon className="h-3.5 w-3.5" />
            New run
          </button>
        )}

        {personRuns.length === 0 ? (
          <p className="px-2 py-3 text-center text-[11px] text-vs-muted">No sessions yet.</p>
        ) : (
          personRuns.map((run) => {
            const active = run.id === enteredRunId;
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
                  title={`${run.status} · ${relativeTime(Math.floor(run.createdAt / 1000))}`}
                  className={`flex min-w-0 flex-1 items-center gap-2 px-2 py-2 text-left ${
                    active ? "text-vs-accent" : "text-vs-fg"
                  }`}
                >
                  <RunStatusDot status={run.status} />
                  <span className="min-w-0 flex-1 truncate text-[12px]">
                    {run.title ?? `${run.agentId} run`}
                  </span>
                  <span className="shrink-0 rounded bg-vs-hover px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-vs-muted">
                    {run.agentId}
                  </span>
                </button>
                {!viewingSelf && (
                  <button
                    type="button"
                    onClick={() => onFork(run)}
                    title="Fork into your own run"
                    aria-label="Fork this session"
                    className="shrink-0 rounded p-1 text-vs-muted opacity-0 transition hover:bg-vs-hover hover:text-vs-fg group-hover:opacity-100"
                  >
                    <GitBranchIcon className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function RunStatusDot({ status }: { status: AgentRun["status"] }) {
  const color =
    status === "running"
      ? "bg-amber-500 [animation:pulse_1.2s_ease-in-out_infinite]"
      : status === "completed"
        ? "bg-emerald-500"
        : status === "failed"
          ? "bg-red-500"
          : "bg-vs-muted";
  return <span className={`h-2 w-2 shrink-0 rounded-full ${color}`} title={status} />;
}
