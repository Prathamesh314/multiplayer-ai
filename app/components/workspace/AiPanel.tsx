"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { agentById, type AgentChoice, type AgentStatus } from "../../lib/ai/catalog";
import { fetchAgents, runAgent, type RunHandle } from "../../lib/ai/client";
import type { AgentRun } from "../../lib/ai/runs";
import { fetchRun } from "../../lib/ai/runs-client";
import { openSessionStream } from "../../lib/events/client";
import { colorOf, initialsOf } from "../../lib/people";
import type { SessionMember } from "../../lib/session/types";
import {
  AlertIcon,
  CheckIcon,
  EyeIcon,
  GitBranchIcon,
  PlusIcon,
  SparkleIcon,
  SpinnerIcon,
} from "../icons";
import { Composer } from "./chat";
import { PanelHeader } from "./TeamChatPanel";

type AiPanelProps = {
  sessionId: string;
  /** False for viewers: running an agent edits files. */
  canRun: boolean;
  /** Room roster, for the "watching" cluster in the header. */
  members: SessionMember[];
  /** The run whose conversation is shown; null = composing a fresh one. */
  entered: AgentRun | null;
  /** Reload the room's runs after this tab starts one. */
  onRunsChanged: () => void;
  /** Clear the entered run to compose a fresh one. */
  onNewRun: () => void;
  /** Omitted when embedded as the center Chat tab, where there is no X to show. */
  onClose?: () => void;
};

/** One line of the conversation, whether streamed live or read from history. */
type Turn = {
  id: string;
  role: "user" | "agent" | "system";
  text: string;
  author?: string | null;
  agentName?: string | null;
  /** True while the agent is still writing into this turn. */
  streaming?: boolean;
};

export function AiPanel({
  sessionId,
  canRun,
  members,
  entered,
  onRunsChanged,
  onNewRun,
  onClose,
}: AiPanelProps) {
  const [agents, setAgents] = useState<AgentStatus[] | null>(null);
  const [serverCanRun, setServerCanRun] = useState(true);
  const [blockedReason, setBlockedReason] = useState<string | null>(null);
  const [connected, setConnected] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [installFor, setInstallFor] = useState<string | null>(null);
  // Composer selectors. Reset together with the provider, since the options do.
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");

  const [turns, setTurns] = useState<Turn[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useRef<RunHandle | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const turnSeq = useRef(0);
  const uid = () => `t${(turnSeq.current += 1)}`;

  const myId = members.find((member) => member.isSelf)?.userId ?? null;
  // Whether the run in view is the current user's (or a fresh compose).
  const enteredIsMine = !entered || entered.startedBy === myId;

  // Refs the live event handlers read, so the one-time subscription below never
  // closes over stale state.
  const enteredRef = useRef<AgentRun | null>(null);
  const localRunIdRef = useRef<string | null>(null); // the run this tab is streaming
  const liveTurnIdRef = useRef<string | null>(null); // the agent turn being followed
  useEffect(() => {
    enteredRef.current = entered;
  }, [entered]);

  /** Load a run's stored conversation into the panel. */
  async function loadRun(target: AgentRun) {
    setError(null);
    liveTurnIdRef.current = null;
    const agentName = agents?.find((a) => a.id === target.agentId)?.name ?? target.agentId;
    setTurns([]);
    try {
      const { messages } = await fetchRun(sessionId, target.id);
      setTurns(
        messages.map((message) => {
          // "tool" turns are the agent's own machinery; show them as agent output.
          const role: Turn["role"] = message.role === "user" ? "user" : message.role === "system" ? "system" : "agent";
          return {
            id: uid(),
            role,
            text: message.body,
            author: message.authorName ?? null,
            agentName: role === "agent" ? agentName : null,
          };
        }),
      );
    } catch {
      setError("Could not load that run.");
    }
  }

  /** Append a live output chunk to the agent turn of a run we are following. */
  function appendFollowChunk(chunk: string) {
    setTurns((prev) => {
      const next = [...prev];
      if (liveTurnIdRef.current === null) {
        const tid = uid();
        liveTurnIdRef.current = tid;
        next.push({
          id: tid,
          role: "agent",
          text: chunk,
          streaming: true,
          agentName: enteredRef.current?.agentId ?? "Agent",
        });
      } else {
        const index = next.findIndex((turn) => turn.id === liveTurnIdRef.current);
        if (index >= 0) next[index] = { ...next[index], text: next[index].text + chunk };
      }
      return next;
    });
  }

  // The conversation follows whichever run is entered: load its stored turns,
  // or clear to compose a fresh one. Deferred so no state is set in the effect body.
  useEffect(() => {
    liveTurnIdRef.current = null;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      if (entered) void loadRun(entered);
      else setTurns([]);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entered?.id]);

  // Realtime: follow the entered run as its output streams from whoever is
  // running it. (The run list itself is refreshed by the room, not here.)
  useEffect(() => {
    const stream = openSessionStream(sessionId, {
      onRunOutput: (event) => {
        if (event.runId === localRunIdRef.current) return; // our own run streams locally
        if (enteredRef.current?.id !== event.runId) return; // not the run in view
        appendFollowChunk(event.chunk);
      },
      onRunTurn: (event) => {
        if (event.runId === localRunIdRef.current) return;
        if (enteredRef.current?.id !== event.runId) return;
        // A prompt from the runner shows immediately; agent output arrives via
        // run.output and is reconciled on finish, so it is not appended here.
        if (event.role === "user") {
          setTurns((prev) => [
            ...prev,
            { id: uid(), role: "user", text: event.body, author: event.authorName ?? "Prompt" },
          ]);
        }
      },
      onRunFinished: (event) => {
        // Reload the entered run so its complete, stored output replaces the
        // live tail (which may have started mid-run).
        const current = enteredRef.current;
        if (current?.id === event.runId && event.runId !== localRunIdRef.current) {
          liveTurnIdRef.current = null;
          void loadRun(current);
        }
      },
    });
    return () => stream.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  useEffect(() => {
    let cancelled = false;
    fetchAgents().then((response) => {
      if (cancelled) return;
      setAgents(response.agents);
      setServerCanRun(response.canRun);
      setBlockedReason(response.reason);
      // Pre-select the one that is ready, so the common case is one click.
      setConnected((previous) => previous ?? response.agents.find((a) => a.installed)?.id ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Follow the conversation as it grows.
  useEffect(() => {
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [turns]);

  async function recheck() {
    setRefreshing(true);
    const response = await fetchAgents(true);
    setAgents(response.agents);
    setServerCanRun(response.canRun);
    setBlockedReason(response.reason);
    setRefreshing(false);
  }

  // Switching provider clears the model/effort picks, whose options differ per agent.
  function selectProvider(id: string) {
    setConnected(id);
    setModel("");
    setEffort("");
    setInstallFor(null);
  }

  function ask(prompt: string) {
    if (!connected || running) return;
    setRunning(true);
    setError(null);

    // Continue only your own unfinished run; a message on someone else's run
    // forks into a fresh run of your own rather than editing theirs.
    const continuing =
      entered && entered.status !== "completed" && entered.startedBy === myId ? entered.id : undefined;
    const agentId = continuing ? entered!.agentId : connected;
    const agentName = agents?.find((a) => a.id === agentId)?.name ?? agentId;

    // Continuing appends to the entered run; a fresh run starts a clean thread.
    const userTurn: Turn = { id: uid(), role: "user", text: prompt, author: "You" };
    setTurns((prev) => (continuing ? [...prev, userTurn] : [userTurn]));

    // The agent's turn is created lazily on its first byte, so an agent that
    // exits without output does not leave an empty bubble.
    let agentTurnId: string | null = null;

    run.current = runAgent(
      { sessionId, agentId, prompt, runId: continuing, model, effort },
      {
        onEvent: (event) => {
          if (event.t === "start") {
            localRunIdRef.current = event.runId; // so the room broadcast of our own run is ignored
            onRunsChanged(); // the new run shows in the sidebar
          } else if (event.t === "out" || event.t === "err") {
            setTurns((prev) => {
              const next = [...prev];
              if (agentTurnId === null) {
                agentTurnId = uid();
                next.push({ id: agentTurnId, role: "agent", text: event.d, agentName, streaming: true });
              } else {
                const index = next.findIndex((turn) => turn.id === agentTurnId);
                if (index >= 0) next[index] = { ...next[index], text: next[index].text + event.d };
              }
              return next;
            });
          } else if (event.t === "notice") {
            setTurns((prev) => [...prev, { id: uid(), role: "system", text: event.message }]);
          } else if (event.t === "exit") {
            const summary =
              `Finished in ${(event.ms / 1000).toFixed(1)}s` +
              (event.committed ? ` · committed ${event.headSha?.slice(0, 8)}` : " · no file changes");
            setTurns((prev) => {
              const next = prev.map((turn) =>
                turn.id === agentTurnId ? { ...turn, streaming: false } : turn,
              );
              next.push({ id: uid(), role: "system", text: summary });
              return next;
            });
          }
        },
        onError: setError,
        onDone: () => {
          setRunning(false);
          localRunIdRef.current = null;
          onRunsChanged();
        },
      },
    );
  }

  const active = agents?.find((agent) => agent.id === connected) ?? null;
  const ready = !!active?.installed && serverCanRun && canRun;
  const hasConversation = turns.length > 0;

  // Static model / effort lists for the connected provider, and the installed
  // providers to switch between — all from the shared catalog.
  const activeSpec = connected ? agentById(connected) : undefined;
  const installedAgents = agents?.filter((agent) => agent.installed) ?? [];

  const composerFooter =
    ready && activeSpec ? (
      <div className="flex min-w-0 items-center gap-0.5">
        <SelectChip
          icon={<SparkleIcon className="h-3.5 w-3.5 text-vs-accent" />}
          value={connected ?? ""}
          onChange={selectProvider}
          options={installedAgents.map((agent) => ({ id: agent.id, label: agent.name }))}
          title="Provider"
        />
        <span className="mx-0.5 h-3.5 w-px bg-vs-border" />
        <SelectChip value={model} onChange={setModel} options={activeSpec.models} title="Model" />
        {activeSpec.efforts.length > 0 && (
          <>
            <span className="mx-0.5 h-3.5 w-px bg-vs-border" />
            <SelectChip
              icon={<BarsIcon className="h-3 w-3 text-vs-muted" />}
              value={effort}
              onChange={setEffort}
              options={activeSpec.efforts}
              title="Capacity"
            />
          </>
        )}
      </div>
    ) : undefined;

  return (
    <aside className="flex h-full min-h-0 w-full flex-col bg-vs-panel">
      <PanelHeader title={entered ? entered.title ?? "Agent run" : "New chat"} onClose={onClose}>
        {entered &&
          (enteredIsMine ? (
            <button
              type="button"
              onClick={onNewRun}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-vs-muted transition hover:bg-vs-hover hover:text-vs-fg"
            >
              <PlusIcon className="h-3 w-3" />
              New
            </button>
          ) : (
            <button
              type="button"
              onClick={onNewRun}
              title={`Branch off ${entered.startedByName}'s session into your own run`}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-vs-muted transition hover:bg-vs-hover hover:text-vs-fg"
            >
              <GitBranchIcon className="h-3 w-3" />
              Fork
            </button>
          ))}
        <WatchingCluster members={members} />
      </PanelHeader>

      {/* Once an agent is ready the provider/model/capacity live in the composer
          footer; the full selector is only for connecting or installing one. */}
      {!ready && (
        <AgentSelector
          agents={agents}
          connected={connected}
          installFor={installFor}
          refreshing={refreshing}
          onSelect={selectProvider}
          onToggleInstall={(id) => setInstallFor((shown) => (shown === id ? null : id))}
          onRecheck={recheck}
        />
      )}

      {!serverCanRun && blockedReason && (
        <Note tone="warn">Agents are detected but will not run here. {blockedReason}</Note>
      )}
      {serverCanRun && !canRun && (
        <Note tone="warn">You have read access here, and running an agent edits files.</Note>
      )}

      <div ref={scroller} className="vs-scroll min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        {hasConversation ? (
          <Conversation turns={turns} />
        ) : (
          <EmptyState
            ready={ready}
            agentName={active?.name ?? null}
            onExample={ask}
          />
        )}
        {error && (
          <p className="mx-3 mb-3 flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-[11px] leading-5 text-red-600 dark:text-red-300">
            <AlertIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {error}
          </p>
        )}
      </div>

      {running ? (
        <div className="flex shrink-0 items-center gap-2 border-t border-vs-border bg-vs-panel p-2.5 text-xs text-vs-muted">
          <SpinnerIcon className="h-3.5 w-3.5 text-vs-accent" />
          <span className="text-vs-fg">{active?.name ?? "Agent"} is working…</span>
          <button
            type="button"
            onClick={() => run.current?.cancel()}
            className="ml-auto rounded border border-vs-border px-2 py-0.5 text-[11px] transition hover:bg-vs-hover hover:text-vs-fg"
          >
            Stop
          </button>
        </div>
      ) : (
        <Composer
          tall
          narrow
          footer={composerFooter}
          placeholder={
            !ready
              ? "Connect an agent first…"
              : entered && !enteredIsMine
                ? `Fork ${entered.startedByName}'s session with ${active!.name}…`
                : `Message ${active!.name}…`
          }
          onSend={ask}
        />
      )}
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Agent selector
// ---------------------------------------------------------------------------

function AgentSelector({
  agents,
  connected,
  installFor,
  refreshing,
  onSelect,
  onToggleInstall,
  onRecheck,
}: {
  agents: AgentStatus[] | null;
  connected: string | null;
  installFor: string | null;
  refreshing: boolean;
  onSelect: (id: string) => void;
  onToggleInstall: (id: string) => void;
  onRecheck: () => void;
}) {
  const detail = agents?.find((agent) => agent.id === installFor);

  return (
    <div className="shrink-0 border-b border-vs-border px-2 py-2">
      <div className="mb-1.5 flex items-center justify-between px-1">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-vs-muted">Agent</span>
        <button
          type="button"
          onClick={onRecheck}
          disabled={refreshing}
          className="text-[10px] uppercase tracking-wide text-vs-muted transition hover:text-vs-fg disabled:opacity-50"
        >
          {refreshing ? "Checking…" : "Recheck"}
        </button>
      </div>

      {agents === null ? (
        <p className="flex items-center gap-2 px-1 py-1.5 text-xs text-vs-muted">
          <SpinnerIcon className="h-3.5 w-3.5" />
          Looking for installed agents…
        </p>
      ) : (
        <div className="flex flex-col gap-1">
          {agents.map((agent) => {
            const selected = connected === agent.id;
            return (
              <button
                key={agent.id}
                type="button"
                onClick={() => (agent.installed ? onSelect(agent.id) : onToggleInstall(agent.id))}
                className={`group flex items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left transition ${
                  selected
                    ? "border-vs-accent bg-vs-accent/10"
                    : "border-transparent hover:border-vs-border hover:bg-vs-hover"
                }`}
              >
                <span
                  className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${
                    agent.installed ? "bg-vs-accent/15 text-vs-accent" : "bg-vs-hover text-vs-muted"
                  }`}
                >
                  <SparkleIcon className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-[13px] font-medium text-vs-fg">{agent.name}</span>
                    {agent.installed && <StatusDot ok />}
                  </span>
                  <span className="block truncate text-[10px] text-vs-muted">
                    {agent.installed ? (agent.version ?? "connected") : `${agent.vendor} · not installed`}
                  </span>
                </span>
                {agent.installed ? (
                  selected ? (
                    <span className="flex shrink-0 items-center gap-1 text-[10px] font-medium text-vs-accent">
                      <CheckIcon className="h-3 w-3" />
                      Connected
                    </span>
                  ) : (
                    <span className="shrink-0 text-[10px] text-vs-muted opacity-0 transition group-hover:opacity-100">
                      Select
                    </span>
                  )
                ) : (
                  <span className="shrink-0 text-[10px] uppercase tracking-wide text-vs-accent">
                    {installFor === agent.id ? "Hide" : "Install"}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {detail && !detail.installed && (
        <div className="mt-1.5 space-y-1.5 rounded-lg border border-vs-border bg-vs-editor p-2">
          <p className="text-[11px] leading-4 text-vs-fg">{detail.blurb}</p>
          <CopyLine command={detail.install.command} />
          {detail.install.alternative && <CopyLine command={detail.install.alternative} />}
          <p className="text-[10px] leading-4 text-vs-muted">
            Run it in a terminal, then press Recheck.{" "}
            <a
              href={detail.install.docs}
              target="_blank"
              rel="noreferrer"
              className="text-vs-accent underline-offset-2 hover:underline"
            >
              Docs
            </a>
          </p>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------

function Conversation({ turns }: { turns: Turn[] }) {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-4">
      {turns.map((turn) =>
        turn.role === "system" ? (
          <SystemLine key={turn.id} text={turn.text} />
        ) : (
          <TurnBubble key={turn.id} turn={turn} />
        ),
      )}
    </div>
  );
}

function TurnBubble({ turn }: { turn: Turn }) {
  const isUser = turn.role === "user";
  return (
    <article className="flex min-w-0 gap-3">
      <span
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ${
          isUser ? "bg-vs-accent text-vs-accent-fg" : "bg-vs-accent/15 text-vs-accent"
        }`}
      >
        {isUser ? (turn.author ?? "You").slice(0, 1).toUpperCase() : <SparkleIcon className="h-4 w-4" />}
      </span>
      <div className="min-w-0 flex-1">
        <header className="mb-1 flex items-center gap-2">
          <span className="truncate text-[13px] font-semibold text-vs-fg">
            {isUser ? turn.author ?? "You" : turn.agentName ?? "Agent"}
          </span>
          {turn.streaming && <SpinnerIcon className="h-3 w-3 shrink-0 text-vs-muted" />}
        </header>
        {isUser ? (
          <div className="w-fit max-w-full whitespace-pre-wrap break-words rounded-xl rounded-tl-sm bg-vs-hover px-3.5 py-2 text-[13px] leading-6 text-vs-fg">
            {turn.text}
          </div>
        ) : (
          <AgentBody text={turn.text} streaming={turn.streaming} />
        )}
      </div>
    </article>
  );
}

/**
 * Renders agent output, splitting fenced ``` blocks into monospace cards while
 * the prose stays proportional. The CLIs emit plain text, so this stays
 * intentionally small rather than a full Markdown engine.
 */
function AgentBody({ text, streaming }: { text: string; streaming?: boolean }) {
  const segments = useMemo(() => splitFences(text), [text]);
  return (
    <div className="space-y-2 text-[13px] leading-5 text-vs-fg/90">
      {segments.map((segment, index) =>
        segment.code ? (
          <pre
            key={index}
            className="vs-scroll overflow-x-auto rounded-md border border-vs-border bg-vs-editor px-3 py-2 font-mono text-[11px] leading-5 text-vs-fg"
          >
            {segment.text}
          </pre>
        ) : (
          <p key={index} className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
            {segment.text}
            {streaming && index === segments.length - 1 && (
              <span className="ml-0.5 inline-block h-3.5 w-1.5 translate-y-0.5 animate-pulse bg-vs-accent" />
            )}
          </p>
        ),
      )}
    </div>
  );
}

function splitFences(text: string): { code: boolean; text: string }[] {
  const parts = text.split(/```[^\n]*\n?/);
  const out: { code: boolean; text: string }[] = [];
  parts.forEach((part, index) => {
    if (part.length === 0) return;
    // Odd segments sit between fence markers, so they are the code blocks.
    out.push({ code: index % 2 === 1, text: index % 2 === 1 ? part.replace(/\n$/, "") : part });
  });
  return out.length > 0 ? out : [{ code: false, text }];
}

function SystemLine({ text }: { text: string }) {
  // Short run boundaries read as a centered divider; a long stderr dump is shown
  // as a wrapped, muted note so it never blows out the panel width.
  if (text.length <= 52 && !text.includes("\n")) {
    return (
      <div className="flex items-center gap-2 px-1">
        <span className="h-px flex-1 bg-vs-border" />
        <span className="shrink-0 text-[10px] text-vs-muted">{text}</span>
        <span className="h-px flex-1 bg-vs-border" />
      </div>
    );
  }
  return (
    <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] rounded-md bg-vs-hover/50 px-3 py-2 font-mono text-[11px] leading-5 text-vs-muted">
      {text}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Empty state & history
// ---------------------------------------------------------------------------

const EXAMPLES = [
  "Explain what this project does",
  "Find and fix any bugs you can see",
  "Add tests for the current file",
];

function EmptyState({
  ready,
  agentName,
  onExample,
}: {
  ready: boolean;
  agentName: string | null;
  onExample: (prompt: string) => void;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-vs-accent/10 text-vs-accent">
        <SparkleIcon className="h-6 w-6" />
      </span>
      <div>
        <p className="text-sm font-medium text-vs-fg">
          {ready ? `Chat with ${agentName}` : "Connect a coding agent"}
        </p>
        <p className="mt-1 max-w-[15rem] text-xs leading-5 text-vs-muted">
          {ready
            ? "Ask it to read, explain, or change the code. Everything it edits is committed to the session."
            : "Pick an installed agent above to start a conversation."}
        </p>
      </div>
      {ready && (
        <div className="flex w-full max-w-[16rem] flex-col gap-1.5">
          {EXAMPLES.map((example) => (
            <button
              key={example}
              type="button"
              onClick={() => onExample(example)}
              className="rounded-lg border border-vs-border px-3 py-2 text-left text-xs text-vs-fg transition hover:border-vs-accent hover:bg-vs-hover"
            >
              {example}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Who is watching
// ---------------------------------------------------------------------------

/** The people currently in the room — "who is watching". */
function WatchingCluster({ members }: { members: SessionMember[] }) {
  const online = members.filter((member) => member.online);
  if (online.length === 0) return null;

  const shown = online.slice(0, 4);
  const extra = online.length - shown.length;

  return (
    <span className="flex items-center gap-1.5" title={`${online.length} watching this room`}>
      <EyeIcon className="h-3.5 w-3.5 text-vs-muted" />
      <span className="flex -space-x-1.5">
        {shown.map((member) => {
          const color = colorOf(member.userId);
          return (
            <span
              key={member.userId}
              title={member.displayName}
              className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-semibold ring-2 ring-vs-panel ${color.chip}`}
            >
              {initialsOf(member.displayName)}
            </span>
          );
        })}
      </span>
      {extra > 0 && <span className="text-[10px] text-vs-muted">+{extra}</span>}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Composer footer selectors
// ---------------------------------------------------------------------------

/** A compact icon + native <select> "chip" for the composer toolbar. */
function SelectChip({
  icon,
  value,
  onChange,
  options,
  title,
}: {
  icon?: React.ReactNode;
  value: string;
  onChange: (value: string) => void;
  options: AgentChoice[];
  title: string;
}) {
  return (
    <label
      title={title}
      className="flex min-w-0 items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-vs-fg transition hover:bg-vs-hover"
    >
      {icon}
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-label={title}
        className="max-w-[7rem] cursor-pointer truncate bg-transparent text-vs-fg outline-none [&>option]:bg-vs-panel [&>option]:text-vs-fg"
      >
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Signal-bar glyph for the capacity selector — no equivalent in the icon set. */
function BarsIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden className={className}>
      <rect x="1" y="10" width="2.5" height="5" rx="0.5" />
      <rect x="5" y="7" width="2.5" height="8" rx="0.5" />
      <rect x="9" y="4" width="2.5" height="11" rx="0.5" />
      <rect x="13" y="1" width="2.5" height="14" rx="0.5" opacity="0.4" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Small shared pieces
// ---------------------------------------------------------------------------

/**
 * The command is shown to copy, never run for you: installing software on the
 * machine hosting this app is the operator's decision, not a button's.
 */
function CopyLine({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      title="Copy"
      className="flex w-full items-center gap-1.5 rounded border border-vs-border bg-vs-panel px-2 py-1 text-left font-mono text-[10px] text-vs-fg transition hover:bg-vs-hover"
    >
      <span className="min-w-0 flex-1 truncate">{command}</span>
      {copied ? (
        <CheckIcon className="h-3 w-3 shrink-0 text-emerald-500" />
      ) : (
        <span className="shrink-0 text-[9px] uppercase text-vs-muted">copy</span>
      )}
    </button>
  );
}

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span
      className={`h-1.5 w-1.5 shrink-0 rounded-full ${ok ? "bg-emerald-500" : "bg-vs-muted"}`}
    />
  );
}

function Note({ children, tone }: { children: React.ReactNode; tone: "warn" }) {
  return (
    <p
      className={`flex items-start gap-2 border-b border-vs-border px-3 py-2 text-[11px] leading-5 text-vs-fg ${
        tone === "warn" ? "bg-amber-500/10" : ""
      }`}
    >
      <AlertIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
      {children}
    </p>
  );
}
