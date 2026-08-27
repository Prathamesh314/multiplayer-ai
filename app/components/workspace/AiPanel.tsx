"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { agentById, type AgentChoice, type AgentStatus } from "../../lib/ai/catalog";
import { fetchAgents, runAgent, type RunHandle } from "../../lib/ai/client";
import type { AgentRun } from "../../lib/ai/runs";
import { fetchRun, listRuns } from "../../lib/ai/runs-client";
import { relativeTime } from "../../lib/format";
import {
  AlertIcon,
  CheckIcon,
  ChevronIcon,
  CloseIcon,
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

export function AiPanel({ sessionId, canRun, onClose }: AiPanelProps) {
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

  // Every run in this room, so a teammate's run can be watched or joined. The
  // run currently loaded into the conversation — null while composing a fresh one.
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [viewing, setViewing] = useState<AgentRun | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  useEffect(() => {
    void listRuns(sessionId).then(setRuns).catch(() => {});
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

  function refreshRuns() {
    void listRuns(sessionId).then(setRuns).catch(() => {});
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
    setShowHistory(false);

    // Continue the run being watched (join-as-editor), or open a fresh one.
    const continuing = viewing && viewing.status !== "completed" ? viewing.id : undefined;
    const agentId = continuing ? viewing!.agentId : connected;
    const agentName = agents?.find((a) => a.id === agentId)?.name ?? agentId;

    setTurns((prev) => [...prev, { id: uid(), role: "user", text: prompt, author: "You" }]);

    // The agent's turn is created lazily on its first byte, so an agent that
    // exits without output does not leave an empty bubble.
    let agentTurnId: string | null = null;

    run.current = runAgent(
      { sessionId, agentId, prompt, runId: continuing, model, effort },
      {
        onEvent: (event) => {
          if (event.t === "start") {
            refreshRuns();
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
          refreshRuns();
        },
      },
    );
  }

  /** Load a run's stored conversation into the panel — the "watch" action. */
  async function watch(target: AgentRun) {
    setViewing(target);
    setError(null);
    setShowHistory(false);
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

  function newRun() {
    setViewing(null);
    setTurns([]);
    setError(null);
    setShowHistory(false);
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
      <PanelHeader title="AI Agents" onClose={onClose}>
        {runs.length > 0 && (
          <button
            type="button"
            onClick={() => setShowHistory((shown) => !shown)}
            className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide transition hover:bg-vs-hover hover:text-vs-fg ${
              showHistory ? "text-vs-accent" : "text-vs-muted"
            }`}
          >
            History
          </button>
        )}
        {(hasConversation || viewing) && (
          <button
            type="button"
            onClick={newRun}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-vs-muted transition hover:bg-vs-hover hover:text-vs-fg"
          >
            <PlusIcon className="h-3 w-3" />
            New
          </button>
        )}
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

      <div ref={scroller} className="vs-scroll min-h-0 flex-1 overflow-y-auto">
        {showHistory ? (
          <HistoryList
            runs={runs}
            viewingId={viewing?.id ?? null}
            onWatch={watch}
            onClose={() => setShowHistory(false)}
          />
        ) : hasConversation ? (
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
              : viewing && viewing.status !== "completed"
                ? `Join ${viewing.startedByName}'s run…`
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
    <div className="flex flex-col gap-4 p-3">
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
    <article className="flex gap-2.5">
      <span
        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ${
          isUser ? "bg-vs-accent text-vs-accent-fg" : "bg-vs-accent/15 text-vs-accent"
        }`}
      >
        {isUser ? "You"[0] : <SparkleIcon className="h-3.5 w-3.5" />}
      </span>
      <div className="min-w-0 flex-1">
        <header className="mb-1 flex items-center gap-2">
          <span className="text-xs font-semibold text-vs-fg">
            {isUser ? turn.author ?? "You" : turn.agentName ?? "Agent"}
          </span>
          {turn.streaming && <SpinnerIcon className="h-3 w-3 text-vs-muted" />}
        </header>
        {isUser ? (
          <p className="whitespace-pre-wrap break-words rounded-lg rounded-tl-sm bg-vs-hover px-3 py-2 text-[13px] leading-5 text-vs-fg">
            {turn.text}
          </p>
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
          <p key={index} className="whitespace-pre-wrap break-words">
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
  return (
    <div className="flex items-center gap-2 px-1">
      <span className="h-px flex-1 bg-vs-border" />
      <span className="shrink-0 text-[10px] text-vs-muted">{text}</span>
      <span className="h-px flex-1 bg-vs-border" />
    </div>
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

function HistoryList({
  runs,
  viewingId,
  onWatch,
  onClose,
}: {
  runs: AgentRun[];
  viewingId: string | null;
  onWatch: (run: AgentRun) => void;
  onClose: () => void;
}) {
  return (
    <div className="p-2">
      <div className="flex items-center justify-between px-1 pb-1.5">
        <h3 className="text-[10px] font-semibold uppercase tracking-wider text-vs-muted">
          Recent runs
        </h3>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-0.5 text-vs-muted transition hover:bg-vs-hover hover:text-vs-fg"
          aria-label="Close history"
        >
          <CloseIcon className="h-3.5 w-3.5" />
        </button>
      </div>
      <ul className="space-y-0.5">
        {runs.map((r) => (
          <li key={r.id}>
            <button
              type="button"
              onClick={() => onWatch(r)}
              className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition ${
                viewingId === r.id ? "bg-vs-accent/10" : "hover:bg-vs-hover"
              }`}
            >
              <RunStatusDot status={r.status} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] text-vs-fg">
                  {r.title ?? `${r.agentId} run`}
                </span>
                <span className="block truncate text-[10px] text-vs-muted">
                  {r.startedByName} · {r.agentId} · {relativeTime(Math.floor(r.createdAt / 1000))}
                </span>
              </span>
              <ChevronIcon className="h-3.5 w-3.5 shrink-0 text-vs-muted" />
            </button>
          </li>
        ))}
      </ul>
    </div>
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

function RunStatusDot({ status }: { status: AgentRun["status"] }) {
  const color =
    status === "running"
      ? "bg-amber-500 animate-pulse"
      : status === "completed"
        ? "bg-emerald-500"
        : status === "failed"
          ? "bg-red-500"
          : "bg-vs-muted";
  return <span className={`h-2 w-2 shrink-0 rounded-full ${color}`} title={status} />;
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
