"use client";

import { useEffect, useRef, useState } from "react";
import type { AgentStatus } from "../../lib/ai/catalog";
import { fetchAgents, runAgent, type RunHandle } from "../../lib/ai/client";
import type { AgentRun } from "../../lib/ai/runs";
import { fetchRun, listRuns } from "../../lib/ai/runs-client";
import { relativeTime } from "../../lib/format";
import { AlertIcon, CheckIcon, EyeIcon, SparkleIcon, SpinnerIcon } from "../icons";
import { Composer } from "./chat";
import { baseName } from "./EditorArea";
import { PanelHeader } from "./TeamChatPanel";

type AiPanelProps = {
  sessionId: string;
  activePath: string | null;
  /** False for viewers: running an agent edits files. */
  canRun: boolean;
  onClose: () => void;
};

export function AiPanel({ sessionId, activePath, canRun, onClose }: AiPanelProps) {
  const [agents, setAgents] = useState<AgentStatus[] | null>(null);
  const [serverCanRun, setServerCanRun] = useState(true);
  const [blockedReason, setBlockedReason] = useState<string | null>(null);
  const [connected, setConnected] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const [output, setOutput] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useRef<RunHandle | null>(null);
  const log = useRef<HTMLPreElement>(null);

  // Every run in this room, so a teammate's run can be watched or joined. The
  // run currently in the output pane — null when composing a fresh one.
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [viewing, setViewing] = useState<AgentRun | null>(null);

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

  useEffect(() => {
    const element = log.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [output]);

  async function recheck() {
    setRefreshing(true);
    const response = await fetchAgents(true);
    setAgents(response.agents);
    setServerCanRun(response.canRun);
    setBlockedReason(response.reason);
    setRefreshing(false);
  }

  function ask(prompt: string) {
    if (!connected || running) return;
    setRunning(true);
    setError(null);
    // Continue the run being watched (join-as-editor), or open a fresh one.
    const continuing = viewing && viewing.status !== "completed" ? viewing.id : undefined;
    setOutput((prev) => (continuing ? `${prev}\n$ ${prompt}\n\n` : `$ ${connected} — ${prompt}\n\n`));

    run.current = runAgent(
      { sessionId, agentId: continuing ? viewing!.agentId : connected, prompt, runId: continuing },
      {
        onEvent: (event) => {
          if (event.t === "start") refreshRuns();
          else if (event.t === "out" || event.t === "err") setOutput((p) => p + event.d);
          else if (event.t === "notice") setOutput((p) => `${p}\n[${event.message}]\n`);
          else if (event.t === "exit") {
            setOutput(
              (p) =>
                `${p}\n[finished in ${(event.ms / 1000).toFixed(1)}s` +
                (event.committed ? ` · committed ${event.headSha?.slice(0, 8)}` : " · no changes") +
                "]\n",
            );
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

  function refreshRuns() {
    void listRuns(sessionId).then(setRuns).catch(() => {});
  }

  /** Open a run's stored conversation in the output pane — the "watch" action. */
  async function watch(target: AgentRun) {
    setViewing(target);
    setError(null);
    setOutput(`# ${target.startedByName} · ${target.agentId}\n\n`);
    try {
      const { messages } = await fetchRun(sessionId, target.id);
      setOutput(
        `# ${target.startedByName} · ${target.agentId}\n\n` +
          messages
            .map((m) => {
              const who = m.role === "user" ? m.authorName ?? "prompt" : m.role;
              return `[${who}]\n${m.body}\n`;
            })
            .join("\n"),
      );
    } catch {
      setError("Could not load that run.");
    }
  }

  function newRun() {
    setViewing(null);
    setOutput("");
    setError(null);
  }

  const active = agents?.find((agent) => agent.id === connected) ?? null;
  const ready = !!active?.installed && serverCanRun && canRun;

  return (
    <aside className="flex h-full min-h-0 w-full flex-col bg-vs-panel">
      <PanelHeader title="AI agents" onClose={onClose}>
        <button
          type="button"
          onClick={recheck}
          disabled={refreshing}
          className="rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-vs-muted transition hover:bg-vs-hover hover:text-vs-fg disabled:opacity-50"
        >
          {refreshing ? "Checking…" : "Recheck"}
        </button>
      </PanelHeader>

      <div className="vs-scroll min-h-0 flex-1 overflow-y-auto">
        {runs.length > 0 && (
          <div className="border-b border-vs-border p-2">
            <div className="flex items-center justify-between px-1 pb-1.5">
              <h3 className="text-[10px] font-semibold uppercase tracking-wider text-vs-muted">
                Agent runs
              </h3>
              {viewing && (
                <button
                  type="button"
                  onClick={newRun}
                  className="rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-vs-accent transition hover:bg-vs-hover"
                >
                  New run
                </button>
              )}
            </div>
            <ul className="space-y-0.5">
              {runs.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => watch(r)}
                    className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition ${
                      viewing?.id === r.id ? "bg-vs-accent/10" : "hover:bg-vs-hover"
                    }`}
                  >
                    <RunStatusDot status={r.status} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12px]">
                        {r.title ?? `${r.agentId} run`}
                      </span>
                      <span className="block truncate text-[10px] text-vs-muted">
                        {r.startedByName} · {r.agentId} ·{" "}
                        {relativeTime(Math.floor(r.createdAt / 1000))}
                      </span>
                    </span>
                    {viewing?.id === r.id && <EyeIcon className="h-3.5 w-3.5 shrink-0 text-vs-accent" />}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="space-y-2 border-b border-vs-border p-2">
          {agents === null ? (
            <p className="flex items-center gap-2 px-1 py-2 text-xs text-vs-muted">
              <SpinnerIcon className="h-3.5 w-3.5" />
              Looking for installed agents…
            </p>
          ) : (
            agents.map((agent) => (
              <AgentCard
                key={agent.id}
                agent={agent}
                connected={connected === agent.id}
                onConnect={() => setConnected(agent.id)}
              />
            ))
          )}
        </div>

        {!serverCanRun && blockedReason && (
          <Note>
            Agents are detected but will not be run here. {blockedReason}
          </Note>
        )}

        {serverCanRun && !canRun && (
          <Note>You have read access to this session, and running an agent edits files.</Note>
        )}

        {output && (
          <pre
            ref={log}
            className="vs-scroll max-h-80 overflow-auto whitespace-pre-wrap break-words border-b border-vs-border p-3 font-mono text-[11px] leading-5 text-vs-fg/90"
          >
            {output}
          </pre>
        )}

        {error && (
          <p className="flex items-start gap-2 border-b border-vs-border bg-red-500/10 px-3 py-2 text-[11px] leading-5 text-red-600 dark:text-red-300">
            <AlertIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {error}
          </p>
        )}
      </div>

      <div className="shrink-0 border-t border-vs-border px-3 py-1.5 text-[10px] leading-4 text-vs-muted">
        {ready ? (
          <>
            {active!.name} runs in this session&apos;s working copy
            {activePath && ` · open file: ${baseName(activePath)}`}. Anything it changes is
            committed and shared.
          </>
        ) : (
          "Connect an installed agent to send it a task."
        )}
      </div>

      {running ? (
        <div className="flex shrink-0 items-center gap-2 border-t border-vs-border p-2 text-xs text-vs-muted">
          <SpinnerIcon className="h-3.5 w-3.5" />
          Working…
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
          placeholder={
            !ready
              ? "Connect an agent first"
              : viewing && viewing.status !== "completed"
                ? `Join ${viewing.startedByName}'s run as editor…`
                : `Ask ${active!.name} to change something…`
          }
          onSend={ask}
        />
      )}
    </aside>
  );
}

function AgentCard({
  agent,
  connected,
  onConnect,
}: {
  agent: AgentStatus;
  connected: boolean;
  onConnect: () => void;
}) {
  const [showInstall, setShowInstall] = useState(false);

  return (
    <div
      className={`rounded-lg border px-2.5 py-2 transition ${
        connected ? "border-vs-accent bg-vs-accent/10" : "border-vs-border"
      }`}
    >
      <div className="flex items-center gap-2">
        <SparkleIcon
          className={`h-3.5 w-3.5 ${agent.installed ? "text-vs-accent" : "text-vs-muted"}`}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-vs-fg">{agent.name}</span>
          <span className="block truncate text-[10px] text-vs-muted">
            {agent.installed ? (agent.version ?? "installed") : agent.vendor}
          </span>
        </span>

        {agent.installed ? (
          <button
            type="button"
            onClick={onConnect}
            disabled={connected}
            className={`shrink-0 rounded px-2 py-1 text-[11px] transition ${
              connected
                ? "text-vs-accent"
                : "border border-vs-border hover:bg-vs-hover hover:text-vs-fg"
            }`}
          >
            {connected ? (
              <span className="flex items-center gap-1">
                <CheckIcon className="h-3 w-3" />
                Connected
              </span>
            ) : (
              "Connect"
            )}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setShowInstall((shown) => !shown)}
            className="shrink-0 rounded border border-vs-border px-2 py-1 text-[11px] transition hover:bg-vs-hover hover:text-vs-fg"
          >
            {showInstall ? "Hide" : "Install"}
          </button>
        )}
      </div>

      <p className="mt-1 text-[10px] leading-4 text-vs-muted">{agent.blurb}</p>

      {showInstall && !agent.installed && (
        <div className="mt-2 space-y-1.5 border-t border-vs-border pt-2">
          <CopyLine command={agent.install.command} />
          {agent.install.alternative && <CopyLine command={agent.install.alternative} />}
          <p className="text-[10px] leading-4 text-vs-muted">
            Run it in the terminal, then press Recheck.{" "}
            <a
              href={agent.install.docs}
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
      className="flex w-full items-center gap-1.5 rounded border border-vs-border bg-vs-editor px-2 py-1 text-left font-mono text-[10px] text-vs-fg transition hover:bg-vs-hover"
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

function Note({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-2 border-b border-vs-border bg-amber-500/10 px-3 py-2 text-[11px] leading-5 text-vs-fg">
      <AlertIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
      {children}
    </p>
  );
}
