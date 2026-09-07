"use client";

import { useEffect, useRef, useState } from "react";
import { fetchTerminalStatus } from "../../lib/terminal/client";
import type { TerminalStatus } from "../../lib/terminal/protocol";
import { AlertIcon, CloseIcon, LinkIcon, PlusIcon, TerminalIcon } from "../icons";
import { XtermView, type XtermHandle } from "./XtermView";

// ---------------------------------------------------------------------------
// Tabbed shell: several independent real terminals, only the active one shown.
// Each tab is one PTY (see app/lib/terminal/pty.ts) rendered by xterm.js.
// ---------------------------------------------------------------------------

type Tab = { id: string; name: string };

export function TerminalPanel({ onClose }: { onClose: () => void }) {
  const [tabs, setTabs] = useState<Tab[]>([{ id: freshId(), name: "Terminal" }]);
  const [activeId, setActiveId] = useState(() => tabs[0].id);
  const [status, setStatus] = useState<TerminalStatus | null>(null);
  const counter = useRef(1);
  const handles = useRef(new Map<string, XtermHandle>());

  useEffect(() => {
    let cancelled = false;
    fetchTerminalStatus()
      .then((next) => !cancelled && setStatus(next))
      .catch((cause: unknown) => {
        if (cancelled) return;
        setStatus({
          enabled: false,
          reason: cause instanceof Error ? cause.message : "The terminal route is unreachable.",
          cwd: "",
          shell: "",
          platform: "",
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Focus whichever terminal just became active (switching between open tabs).
  useEffect(() => {
    handles.current.get(activeId)?.focus();
  }, [activeId]);

  function addTab() {
    counter.current += 1;
    const id = freshId();
    setTabs((previous) => [...previous, { id, name: `Terminal ${counter.current}` }]);
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

  const port = typeof window !== "undefined" ? window.location.port || "3000" : "3000";
  const disabled = status !== null && !status.enabled;

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-vs-terminal">
      <header className="flex h-9 shrink-0 items-center gap-1 border-b border-vs-border bg-vs-terminal-head px-2">
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
          <a
            href={`http://localhost:${port}`}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 rounded border border-vs-border px-2 py-0.5 text-[11px] text-vs-muted transition hover:bg-vs-hover hover:text-vs-fg"
          >
            <LinkIcon className="h-3 w-3" />
            Open :{port}
          </a>
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

      {disabled ? (
        <div className="flex flex-1 items-center justify-center bg-vs-terminal px-6">
          <p className="flex max-w-md items-start gap-2 text-xs leading-5 text-vs-muted">
            <AlertIcon className="mt-0.5 h-4 w-4 shrink-0 text-vs-warn" />
            {status?.reason}
          </p>
        </div>
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
      className={`group flex shrink-0 items-center gap-1.5 rounded-md py-1 pl-2 pr-1 text-[12px] transition ${
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
