"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchAgents, type AgentStatus } from "../../lib/ai/client";
import { CheckIcon, SpinnerIcon } from "../icons";
import { GhostButton, Modal, PrimaryButton } from "../ui/Modal";

/** An agent that can take a run right now: installed, and signed in if it needs to be. */
export function agentReady(agent: AgentStatus): boolean {
  return agent.installed && (!agent.auth || agent.auth.loggedIn)
    && (!["opencode", "ollama", "codex-ollama", "codex-lmstudio"].includes(agent.id) || !!agent.models?.choices.length);
}

export function ConnectAiDialog({ onClose, onOpenDevices }: { onClose: () => void; onOpenDevices?: () => void }) {
  const [agents, setAgents] = useState<AgentStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(true);
  const [canRun, setCanRun] = useState(false);

  const reload = useCallback((refresh = false) =>
    fetchAgents(refresh).then(response => {
      setAgents(response.agents);
      setCanRun(response.canRun);
    }).catch(cause => {
      setError(cause instanceof Error ? cause.message : "Could not check your AI connections. Try again.");
    }).finally(() => {
      setRefreshing(false);
    }), []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const readyCount = agents?.filter(agentReady).length ?? 0;

  return (
    <Modal
      title="Connect your AI"
      description="Connect an AI you already use. Install and sign in on the computer that will run your tasks; then choose its model in a room."
      width="max-w-xl"
      onClose={onClose}
      footer={
        <>
          <span className="mr-auto text-[12px] text-vs-muted">
            {agents === null ? "" : `${readyCount} execution option${readyCount === 1 ? "" : "s"} detected`}
          </span>
          <PrimaryButton onClick={onClose}>
            {readyCount > 0 ? "Done" : "Skip for now"}
          </PrimaryButton>
        </>
      }
    >
      <div className="rounded-xl border border-vs-border bg-vs-editor p-3 text-sm leading-6 text-vs-muted">
        <p className="mb-2">Reading shared conversations and leaving permitted comments works in your browser without this setup.</p>
        <p><strong className="text-vs-fg">1. Connect your computer.</strong> Open the desktop app and sign in with this account.</p>
        <p><strong className="text-vs-fg">2. Choose an AI tool.</strong> Install Git and one of the tools below on that computer, then sign in to the tool with your AI account. You only need one AI tool.</p>
        <p><strong className="text-vs-fg">3. Start chatting.</strong> Check the connection below, then open a project’s room and send your first message.</p>
        {onOpenDevices && <button type="button" onClick={onOpenDevices} className="mt-2 rounded-lg border border-vs-border px-3 py-1.5 font-medium text-vs-fg hover:bg-vs-hover">Connect your computer</button>}
      </div>
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-vs-muted">{canRun ? "AI tools detected. Choose a model in your chat to get started." : "No AI tool is ready yet. Keep your computer connected while you complete setup."}</p>
        <GhostButton onClick={() => { setError(null); setRefreshing(true); void reload(true); }} disabled={refreshing}>{refreshing ? "Checking…" : "Check connections"}</GhostButton>
      </div>
      {error && (
        <p role="alert" className="rounded-lg border border-vs-danger/40 bg-vs-danger/10 px-3 py-2 text-sm text-vs-danger">
          {error}
        </p>
      )}

      {agents === null && !error ? (
        <div className="flex justify-center py-8">
          <SpinnerIcon className="h-5 w-5 text-vs-muted" />
        </div>
      ) : (
        <ul className="space-y-2">
          {(agents ?? []).map((agent) => {
            const ready = agentReady(agent);
            return (
              <li key={agent.id} className="rounded-lg border border-vs-border px-3.5 py-3">
                <div className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 text-[14px] font-medium text-vs-fg">
                      {agent.name}
                      <span className="text-[12px] font-normal text-vs-muted">{agent.vendor}</span>
                      {ready && <CheckIcon className="h-3.5 w-3.5 text-vs-success" />}
                    </p>
                    <p className="mt-0.5 text-[12px] leading-5 text-vs-muted">{agent.blurb}</p>
                    <p className="mt-0.5 text-[12px] text-vs-muted">
                      {agent.installed ? "Detected on your connected computer · uses its sign-in and provider configuration" : "Not detected on a connected computer. Install it there and sign in to it in a terminal on that computer."}
                    </p>
                    {agent.installed && !ready && <p className="mt-1 text-xs text-vs-warn">No models available yet. Connect a provider or install a compatible local model, then check again.</p>}
                  </div>

                </div>

                {!agent.installed && (
                  <div className="mt-2 flex items-center gap-2">
                    <code className="flex-1 truncate rounded-md border border-vs-border bg-vs-editor px-2.5 py-1.5 font-mono text-[12px] text-vs-fg">
                      {agent.install.command}
                    </code>
                    <GhostButton
                      onClick={() => {
                        void navigator.clipboard.writeText(agent.install.command).then(() => {
                          setCopiedId(agent.id);
                          setTimeout(() => setCopiedId(null), 1500);
                        }).catch(() => setError("Could not copy. Select and copy the installation command manually."));
                      }}
                    >
                      {copiedId === agent.id ? "Copied" : "Copy"}
                    </GhostButton>
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
