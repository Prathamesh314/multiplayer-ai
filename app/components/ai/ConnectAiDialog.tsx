"use client";

/*
 * Set up AI: which AI tools the connected computer can run. Tools are detected
 * by that computer's runner; each row says Ready, Sign in needed (with the
 * command to sign in), No models yet, or Not installed (with the command to
 * install it, for that computer's operating system).
 */

import { useCallback, useEffect, useState } from "react";
import { fetchAgents, type AgentStatus } from "../../lib/ai/client";
import { CheckIcon, SpinnerIcon } from "../icons";
import { Modal, PrimaryButton } from "../ui/Modal";
import { useComputerConnection } from "./useComputerConnection";

const NEEDS_MODEL = ["opencode", "ollama", "codex-ollama", "codex-lmstudio"];

/** An agent that can take a run right now: installed, and signed in if it needs to be. */
export function agentReady(agent: AgentStatus): boolean {
  return agent.installed && (!agent.auth || agent.auth.loggedIn)
    && (!NEEDS_MODEL.includes(agent.id) || !!agent.models?.choices.length);
}

type State = "ready" | "sign-in" | "models" | "missing" | "git";

/** Installing Git for that computer's operating system. AI tasks cannot run without it. */
export function gitInstall(platform: string | null | undefined): { command: string | null; note: string } {
  if (platform === "win32") return { command: "winget install --id Git.Git -e --source winget", note: "In PowerShell, or download Git for Windows from git-scm.com. Then restart the Multicode AI app or runner." };
  if (platform === "darwin") return { command: "xcode-select --install", note: "Installs Apple’s command-line tools, which include Git (or use brew install git). Then restart the Multicode AI app or runner." };
  if (platform === "linux") return { command: "sudo apt install git", note: "On Ubuntu or Debian; on other distributions use your package manager. Then restart the Multicode AI app or runner." };
  return { command: null, note: "Download it from git-scm.com/downloads, then restart the Multicode AI app or runner." };
}

function stateOf(agent: AgentStatus, gitMissing: boolean): State {
  if (!agent.installed) return "missing";
  if (gitMissing) return "git";
  if (agent.auth && !agent.auth.loggedIn) return "sign-in";
  return agentReady(agent) ? "ready" : "models";
}

/** The install step for this computer: a Homebrew command means nothing on Windows. */
function installStep(agent: AgentStatus, platform: string | null | undefined): { command: string | null; note: string | null } {
  const { command, alternative } = agent.install;
  if (platform === "win32" && command.startsWith("brew ")) {
    return alternative && !alternative.startsWith("brew ") && !alternative.includes("| bash")
      ? { command: null, note: alternative }
      : { command: null, note: `See ${agent.install.docs} for Windows.` };
  }
  return { command, note: null };
}

export function ConnectAiDialog({ onClose, onOpenDevices }: { onClose: () => void; onOpenDevices?: () => void }) {
  const connection = useComputerConnection();
  const [agents, setAgents] = useState<AgentStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(true);

  const reload = useCallback((refresh = false) =>
    fetchAgents(refresh).then(response => {
      setAgents(response.agents);
    }).catch(cause => {
      setError(cause instanceof Error ? cause.message : "Could not check your AI tools. Try again.");
    }).finally(() => {
      setRefreshing(false);
    }), []);

  useEffect(() => {
    void reload();
  }, [reload]);

  function recheck() {
    setError(null);
    setRefreshing(true);
    void connection.refresh();
    void reload(true);
  }

  function copy(id: string, text: string) {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(id);
      setTimeout(() => setCopied(null), 1600);
    }).catch(() => setError("Could not copy. Select and copy the command manually."));
  }

  const connected = connection.status === "connected";
  const computer = connection.computer;
  const platform = computer?.platform;
  // AI tasks run in a Git worktree: without Git on the computer, nothing is ready.
  const gitMissing = connected && computer?.git === "missing";
  const readyCount = gitMissing ? 0 : agents?.filter(agentReady).length ?? 0;
  const git = gitInstall(platform);

  return (
    <Modal
      title="Set up AI"
      description="Install and sign in to an AI tool on the computer that runs your tasks. Installed tools are detected automatically; you need at least one. Reading and commenting on shared chats needs no setup."
      width="max-w-xl"
      onClose={onClose}
      footer={
        <>
          <span role="status" className="mr-auto text-[12px] text-vs-muted">
            {agents === null ? "" : gitMissing ? "Install Git to run your AI tools" : `${readyCount} of ${agents.length} AI tools ready`}
          </span>
          <PrimaryButton onClick={onClose}>{readyCount > 0 ? "Done" : "Skip for now"}</PrimaryButton>
        </>
      }
    >
      <section aria-label="Connected computer" className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-vs-border bg-vs-editor px-3.5 py-2.5 text-[12.5px]">
        <div className="flex min-w-0 items-center gap-2">
          <span className={`h-2 w-2 shrink-0 rounded-full ${connected ? "bg-vs-success" : connection.status === "checking" ? "bg-vs-muted/40" : "bg-vs-warn"}`} />
          <span className="truncate font-medium text-vs-fg">
            {connected ? computer?.name ?? "Connected computer"
              : connection.status === "checking" ? "Checking your computer…"
              : connection.status === "offline" ? `${computer?.name ?? "Your computer"} is offline`
              : connection.status === "update" ? `${computer?.name ?? "Your computer"} needs an update`
              : connection.status === "error" ? "Couldn’t check your computer"
              : "No computer connected"}
          </span>
          {connected && <span className="shrink-0 text-vs-muted">· connected</span>}
          {connected && computer?.git && (gitMissing
            ? <span className="shrink-0 rounded border border-vs-danger/40 bg-vs-danger/10 px-1.5 py-0.5 font-mono text-[10.5px] text-vs-danger">Git missing</span>
            : <span title="Git, which AI tasks need, is installed" className="inline-flex shrink-0 items-center gap-1 rounded border border-vs-border bg-vs-panel px-1.5 py-0.5 font-mono text-[10.5px] text-vs-muted"><CheckIcon className="h-2.5 w-2.5 text-vs-success" />Git {computer.git}</span>)}
        </div>
        <div className="flex items-center gap-1.5">
          <button type="button" onClick={recheck} disabled={refreshing || connection.checking}
            className="rounded-lg border border-vs-border bg-vs-panel px-2.5 py-1 text-[12px] text-vs-fg transition hover:bg-vs-hover disabled:opacity-60">
            {refreshing || connection.checking ? "Checking…" : "Check again"}
          </button>
          {onOpenDevices && (connected
            ? <button type="button" onClick={onOpenDevices} className="px-2 py-1 text-[12px] text-vs-muted transition hover:text-vs-fg">Change</button>
            : <button type="button" onClick={onOpenDevices} className="rounded-lg bg-vs-accent px-2.5 py-1 text-[12px] font-medium text-vs-accent-fg transition hover:opacity-90">Connect computer</button>)}
        </div>
      </section>
      {gitMissing && (
        <section aria-label="Git is missing" role="alert" className="-mt-1 space-y-2 rounded-xl border border-vs-danger/40 bg-vs-danger/5 p-3.5">
          <p className="text-[13px] font-semibold text-vs-fg">Install Git on {computer?.name ?? "your computer"}</p>
          <p className="text-[12px] leading-5 text-vs-muted">AI tools work in a Git copy of your project, so nothing can run until Git is installed. {git.note}</p>
          {git.command && (
            <div className="flex items-center gap-2 rounded-lg border border-vs-border bg-vs-panel py-1.5 pl-3 pr-1.5">
              <code className="vs-scroll min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-[12px] text-vs-fg">{git.command}</code>
              <button type="button" aria-label="Copy the Git install command" onClick={() => copy("git", git.command!)}
                className="shrink-0 rounded-md border border-vs-border bg-vs-editor px-2.5 py-1 text-[11.5px] text-vs-fg transition hover:bg-vs-hover">
                {copied === "git" ? "Copied ✓" : "Copy"}
              </button>
            </div>
          )}
        </section>
      )}
      {!connected && connection.status !== "checking" && (
        <p className="-mt-2 text-[12.5px] leading-5 text-vs-muted">AI tools are detected on your computer, so connect it first: open the desktop app and sign in with this account.</p>
      )}

      {error && (
        <p role="alert" className="rounded-lg border border-vs-danger/40 bg-vs-danger/10 px-3 py-2 text-sm text-vs-danger">{error}</p>
      )}

      {agents === null && !error ? (
        <div className="flex justify-center py-8"><SpinnerIcon className="h-5 w-5 text-vs-muted" /></div>
      ) : (
        <ul aria-label="AI tools" className="space-y-2.5">
          {(agents ?? []).map((agent) => {
            const state = stateOf(agent, gitMissing);
            const install = installStep(agent, platform);
            const step = state === "missing" ? install.command : state === "sign-in" ? agent.install.signIn ?? null : null;
            return (
              <li key={agent.id} className="rounded-xl border border-vs-border bg-vs-editor p-3.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2">
                      <span className="text-[14px] font-semibold text-vs-fg">{agent.name}</span>
                      <span className="text-[11.5px] text-vs-muted">{agent.vendor}</span>
                    </p>
                    <p className="mt-0.5 text-[12px] leading-5 text-vs-muted">{agent.blurb}</p>
                  </div>
                  <StatePill state={state} />
                </div>

                {state === "models" && <p className="mt-2 text-[12px] leading-5 text-vs-warn">Installed, but no models yet. Connect a provider or install a compatible local model, then check again.</p>}
                {state === "sign-in" && <p className="mt-2 text-[12px] leading-5 text-vs-muted">Installed on your computer. Sign in to it there{agent.install.signIn ? ", in a terminal:" : "."}</p>}
                {state === "missing" && (install.note
                  ? <p className="mt-2 text-[12px] leading-5 text-vs-muted">{install.note}</p>
                  : <p className="mt-2 text-[12px] leading-5 text-vs-muted">Install it on your computer, in a terminal{agent.install.signIn && <>, then sign in with <code className="font-mono text-vs-fg">{agent.install.signIn}</code></>}:</p>)}
                {step && (
                  <div className="mt-2 flex items-center gap-2 rounded-lg border border-vs-border bg-vs-panel py-1.5 pl-3 pr-1.5">
                    <code className="vs-scroll min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-[12px] text-vs-fg">{step}</code>
                    <button type="button" aria-label={`Copy the ${agent.name} command`} onClick={() => copy(agent.id, step)}
                      className="shrink-0 rounded-md border border-vs-border bg-vs-editor px-2.5 py-1 text-[11.5px] text-vs-fg transition hover:bg-vs-hover">
                      {copied === agent.id ? "Copied ✓" : "Copy"}
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Modal>
  );
}

function StatePill({ state }: { state: State }) {
  if (state === "ready") {
    return <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-vs-success/25 bg-vs-success/10 px-2.5 py-1 text-[12px] font-medium text-vs-success"><CheckIcon className="h-3 w-3" />Ready</span>;
  }
  const label = state === "sign-in" ? "Sign in needed" : state === "models" ? "No models yet" : state === "git" ? "Needs Git" : "Not installed";
  const tone = state === "missing" ? "border-vs-border bg-vs-panel text-vs-muted" : "border-vs-warn/30 bg-vs-warn/10 text-vs-warn";
  return <span className={`inline-flex shrink-0 items-center rounded-full border px-2.5 py-1 text-[11.5px] font-medium ${tone}`}>{label}</span>;
}
