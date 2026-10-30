"use client";

import { useEffect, useRef, useState } from "react";
import type { ComputerStatus } from "../ai/useComputerConnection";
import { fetchTerminalStatus, type TerminalContext } from "../../lib/terminal/client";
import type { TerminalStatus } from "../../lib/terminal/protocol";
import { AlertIcon, CloseIcon, LinkIcon, PlusIcon, TerminalIcon } from "../icons";
import { XtermView, type XtermHandle } from "./XtermView";

// ---------------------------------------------------------------------------
// Tabbed shell: several independent real terminals, only the active one shown.
// Each tab is one PTY (see app/lib/terminal/pty.ts) rendered by xterm.js.
// ---------------------------------------------------------------------------

type Tab = { id: string; name: string; context: TerminalContext | null };

/**
 * `context` is the chat (or room) in view: each new tab opens in its worktree
 * on the member's computer and keeps it, even when another chat is opened.
 */
export function TerminalPanel({ onClose, context = null, computerStatus, onConnectComputer }: {
  onClose: () => void;
  context?: TerminalContext | null;
  /** The same computer check as the room header, to say why a terminal can't open. */
  computerStatus?: ComputerStatus;
  onConnectComputer?: () => void;
}) {
  const [tabs, setTabs] = useState<Tab[]>(() => [{ id: freshId(), name: "Terminal", context }]);
  const [checks, setChecks] = useState(0);
  const [activeId, setActiveId] = useState(() => tabs[0].id);
  const [status, setStatus] = useState<TerminalStatus | null>(null);
  const counter = useRef(1);
  const handles = useRef(new Map<string, XtermHandle>());

  useEffect(() => {
    let cancelled = false;
    fetchTerminalStatus(context)
      .then((next) => !cancelled && setStatus(next))
      .catch((cause: unknown) => {
        if (cancelled) return;
        setStatus({
          enabled: false,
          reason: cause instanceof Error ? cause.message : "The terminal route is unreachable.",
          location: "computer",
          cwd: "",
          shell: "",
          platform: "",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [context?.sessionId, context?.runId, context?.repoId, checks]); // eslint-disable-line react-hooks/exhaustive-deps

  // Focus whichever terminal just became active (switching between open tabs).
  useEffect(() => {
    handles.current.get(activeId)?.focus();
  }, [activeId]);

  function addTab() {
    counter.current += 1;
    const id = freshId();
    setTabs((previous) => [...previous, { id, name: `Terminal ${counter.current}`, context }]);
    setActiveId(id);
  }

  function closeTab(id: string) {
    setTabs((previous) => {
      const next = previous.filter((tab) => tab.id !== id);
      if (next.length === 0) {
        onClose();
        return previous;
      }
      if (id === activeId) setActiveId(next[next.length - 1].id);
      return next;
    });
  }

  // "Open :3000" is a local-development convenience — a hosted deployment is
  // already being viewed at its own origin, so the link has nothing to offer.
  const port = typeof window !== "undefined" && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname)
    ? window.location.port || "3000"
    : null;
  const disabled = status !== null && !status.enabled;

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-vs-terminal">
      <header className="flex h-8 shrink-0 items-center gap-1 border-b border-vs-border bg-vs-terminal-head px-2">
        <div className="vs-scroll flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
          {tabs.map((tab) => (
            <TabButton
              key={tab.id}
              tab={tab}
              active={tab.id === activeId}
              closable={tabs.length > 1}
              onSelect={() => setActiveId(tab.id)}
              onClose={() => closeTab(tab.id)}
            />
          ))}
          <button
            type="button"
            onClick={addTab}
            aria-label="New terminal"
            title="New terminal"
            className="ml-0.5 shrink-0 rounded p-1 text-vs-muted transition hover:bg-vs-hover hover:text-vs-fg"
          >
            <PlusIcon className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="ml-2 flex shrink-0 items-center gap-1">
          {status?.enabled && (
            <span className="hidden max-w-[16rem] truncate px-1 text-[11px] text-vs-muted sm:inline"
              title={status.location === "computer" ? "Shells run on your computer, in each tab's chat worktree" : "Shells run on the machine serving this app"}>
              {status.location === "computer" ? `Your computer · ${status.device ?? "connected"}` : "This server"}
            </span>
          )}
          {port && (
            <a
              href={`http://localhost:${port}`}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1 rounded border border-vs-border px-1.5 py-0.5 text-[11px] text-vs-muted transition hover:bg-vs-hover hover:text-vs-fg"
            >
              <LinkIcon className="h-3 w-3" />
              Open :{port}
            </a>
          )}
          <button
            type="button"
            onClick={() => handles.current.get(activeId)?.clear()}
            title="Clear (or Ctrl+L)"
            className="rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-vs-muted transition hover:bg-vs-hover hover:text-vs-fg"
          >
            Clear
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close terminal"
            className="rounded p-0.5 text-vs-muted transition hover:bg-vs-hover hover:text-vs-fg"
          >
            <CloseIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>

      {status === null ? (
        <p role="status" className="flex flex-1 items-center justify-center bg-vs-terminal px-6 text-sm text-vs-muted">Opening a terminal…</p>
      ) : disabled ? (
        <TerminalUnavailable status={status} computerStatus={computerStatus} onConnectComputer={onConnectComputer}
          onCheckAgain={() => { setStatus(null); setChecks((value) => value + 1); }} />
      ) : (
        // Every tab stays mounted (its shell and stream persist); only the active
        // one is shown. Rendered only once status confirms the terminal is enabled.
        status?.enabled &&
        tabs.map((tab) => (
          <div
            key={tab.id}
            className={tab.id === activeId ? "flex min-h-0 flex-1 flex-col" : "hidden"}
          >
            <XtermView
              id={tab.id}
              context={tab.context}
              ref={(handle) => {
                if (handle) handles.current.set(tab.id, handle);
                else handles.current.delete(tab.id);
              }}
            />
          </div>
        ))
      )}
    </section>
  );
}

/**
 * Why no shell opened, in plain words, and what you can do about it. Nothing
 * is run for you: connecting a computer and checking again are your choice.
 */
function TerminalUnavailable({ status, computerStatus, onConnectComputer, onCheckAgain }: {
  status: TerminalStatus;
  computerStatus?: ComputerStatus;
  onConnectComputer?: () => void;
  onCheckAgain: () => void;
}) {
  const onComputer = status.location === "computer";
  const [title, detail, action] = !onComputer ? ["The terminal is unavailable here", status.reason, null]
    : computerStatus === "offline" ? ["Your computer is offline", "The terminal opens a shell on your computer, in this chat’s folder. It is closed, paused or asleep: open the desktop app on it, then check again.", "Reconnect computer"]
    : computerStatus === "update" ? ["Your computer’s app needs an update", "Update the desktop app or runner on your computer to open a terminal here.", "Update computer"]
    : computerStatus === "not-connected" ? ["No computer connected", "The terminal opens a shell on your computer, in this chat’s folder. Connect your computer to use it.", "Connect computer"]
    : ["The terminal couldn’t open", status.reason, null];
  return (
    <div className="flex flex-1 items-center justify-center bg-vs-terminal px-6 py-4">
      <div role="status" className="flex max-w-md items-start gap-2.5 text-left">
        <AlertIcon className="mt-0.5 h-4 w-4 shrink-0 text-vs-warn" />
        <div className="min-w-0">
          <p className="text-[13px] font-medium text-vs-fg">{title}</p>
          <p className="mt-1 text-[12.5px] leading-5 text-vs-muted">{detail}</p>
          {onComputer && (
            <div className="mt-3 flex flex-wrap gap-2">
              {action && onConnectComputer && (
                <button type="button" onClick={onConnectComputer} className="min-h-8 rounded-lg bg-vs-accent px-3 py-1 text-xs font-medium text-vs-accent-fg hover:opacity-90">{action}</button>
              )}
              <button type="button" onClick={onCheckAgain} className="min-h-8 rounded-lg border border-vs-border px-3 py-1 text-xs text-vs-fg hover:bg-vs-hover">Check again</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function TabButton({
  tab,
  active,
  closable,
  onSelect,
  onClose,
}: {
  tab: Tab;
  active: boolean;
  closable: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  return (
    <span
      className={`group flex shrink-0 items-center gap-1.5 rounded-md py-1 pl-2 pr-1 text-[11.5px] transition ${
        active ? "bg-vs-terminal text-vs-fg" : "text-vs-muted hover:bg-vs-hover hover:text-vs-fg"
      }`}
    >
      <button type="button" onClick={onSelect} className="flex items-center gap-1.5">
        <TerminalIcon className={`h-3.5 w-3.5 ${active ? "text-vs-accent" : ""}`} />
        {tab.name}
      </button>
      {closable ? (
        <button
          type="button"
          onClick={onClose}
          aria-label={`Close ${tab.name}`}
          className="rounded p-0.5 text-vs-muted opacity-0 transition hover:bg-vs-hover hover:text-vs-fg group-hover:opacity-100"
        >
          <CloseIcon className="h-3 w-3" />
        </button>
      ) : (
        <span className="w-2" />
      )}
    </span>
  );
}

/** A stable per-tab id that keys the server-side PTY. */
function freshId(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `t${Math.floor(Math.random() * 1e9)}`;
}
