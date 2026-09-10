"use client";

/*
 * The "connect your AI" step: one place that shows every provider this app can
 * drive — Claude Code, Codex, Gemini, and local models via Ollama — with its
 * install and sign-in state, and lets the user connect each before they start
 * working. Opened automatically on first run when nothing is connected, and
 * any time afterwards from the profile menu.
 *
 * Nothing here owns a credential: install state is read by probing the CLI,
 * and sign-in drives the vendor CLI's own OAuth flow (the same machinery the
 * chat panel uses). Local providers have no sign-in at all — installed means
 * connected, and nothing leaves the machine.
 */

import { useEffect, useRef, useState } from "react";
import {
  fetchAgents,
  loginAgent,
  logoutAgent,
  type AgentStatus,
  type RunHandle,
} from "../../lib/ai/client";
import { CheckIcon, SpinnerIcon } from "../icons";
import { GhostButton, Modal, PrimaryButton } from "../ui/Modal";

/** An agent that can take a run right now: installed, and signed in if it needs to be. */
export function agentReady(agent: AgentStatus): boolean {
  return agent.installed && (!agent.auth || agent.auth.loggedIn);
}

export function ConnectAiDialog({ onClose }: { onClose: () => void }) {
  const [agents, setAgents] = useState<AgentStatus[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loginLog, setLoginLog] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const login = useRef<RunHandle | null>(null);

  const reload = (refresh = true) =>
    fetchAgents(refresh).then((response) => setAgents(response.agents));

  useEffect(() => {
    // First read from the cache (instant), then force a re-probe so a CLI
    // installed while this dialog was closed shows up without a manual refresh.
    void reload(false).then(() => reload(true));
    return () => login.current?.cancel();
  }, []);

  function connect(agentId: string) {
    setBusyId(agentId);
    setLoginLog("");
    setError(null);
    login.current = loginAgent(agentId, {
      onEvent: (event) => {
        if (event.t === "out" || event.t === "err") {
          setLoginLog((previous) => (previous + event.d).slice(-4000));
        }
        if (event.t === "exit") {
          setBusyId(null);
          setLoginLog("");
          if (!event.auth?.loggedIn) {
            setError("Sign-in didn't complete. Try again, or run the CLI's login in a terminal.");
          }
          void reload();
        }
      },
      onError: (message) => {
        setBusyId(null);
        setError(message);
      },
      onDone: () => {},
    });
  }

  async function disconnect(agentId: string) {
    setBusyId(agentId);
    setError(null);
    try {
      await logoutAgent(agentId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not sign out.");
    } finally {
      setBusyId(null);
      void reload();
    }
  }

  const readyCount = agents?.filter(agentReady).length ?? 0;

  return (
    <Modal
      title="Connect your AI"
      description="Sign in to the coding agents you use — or run models locally. You need at least one to start a chat."
      width="max-w-xl"
      onClose={onClose}
      footer={
        <>
          <span className="mr-auto text-[12px] text-vs-muted">
            {agents === null ? "" : `${readyCount} of ${agents.length} connected`}
          </span>
          <PrimaryButton onClick={onClose} disabled={busyId !== null}>
            {readyCount > 0 ? "Done" : "Skip for now"}
          </PrimaryButton>
        </>
      }
    >
      {error && (
        <p className="rounded-lg border border-vs-danger/40 bg-vs-danger/10 px-3 py-2 text-sm text-vs-danger">
          {error}
        </p>
      )}

      {agents === null ? (
        <div className="flex justify-center py-8">
          <SpinnerIcon className="h-5 w-5 text-vs-muted" />
        </div>
      ) : (
        <ul className="space-y-2">
          {agents.map((agent) => {
            const ready = agentReady(agent);
            const needsLogin = agent.installed && agent.auth && !agent.auth.loggedIn;
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
                      {!agent.installed
                        ? "Not installed"
                        : agent.auth
                          ? agent.auth.loggedIn
                            ? `Connected${agent.auth.email ? ` · ${agent.auth.email}` : ""}${agent.auth.plan ? ` · ${agent.auth.plan}` : ""}`
                            : "Installed · not signed in"
                          : "Ready · runs entirely on this machine"}
                    </p>
                  </div>

                  {needsLogin && (
                    <PrimaryButton onClick={() => connect(agent.id)} disabled={busyId !== null}>
                      {busyId === agent.id ? <SpinnerIcon className="h-4 w-4" /> : null} Connect
                    </PrimaryButton>
                  )}
                  {agent.installed && agent.auth?.loggedIn && (
                    <GhostButton onClick={() => void disconnect(agent.id)} disabled={busyId !== null}>
                      Sign out
                    </GhostButton>
                  )}
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
                        });
                      }}
                    >
                      {copiedId === agent.id ? "Copied" : "Copy"}
                    </GhostButton>
                  </div>
                )}

                {busyId === agent.id && loginLog && (
                  <pre className="vs-scroll mt-2 max-h-32 overflow-y-auto whitespace-pre-wrap rounded-md border border-vs-border bg-vs-editor p-2 font-mono text-[11px] leading-4 text-vs-muted">
                    {loginLog}
                  </pre>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Modal>
  );
}
