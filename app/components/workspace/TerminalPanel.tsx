"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AnsiBuffer, type Segment } from "../../lib/terminal/ansi";
import { fetchTerminalStatus, interruptRun, runCommand } from "../../lib/terminal/client";
import type { TerminalStatus } from "../../lib/terminal/protocol";
import { AlertIcon, CloseIcon, LinkIcon, PlusIcon, SpinnerIcon, TerminalIcon } from "../icons";

type Block = {
  id: string;
  command: string;
  cwd: string;
  output: AnsiBuffer;
  notices: string[];
  running: boolean;
  exitCode: number | null;
  signal: string | null;
  ms: number;
  failure?: string;
};

/** Blocks kept before the oldest are dropped. */
const MAX_BLOCKS = 120;

/** Imperative hooks the shared header uses to drive the active terminal. */
type InstanceHandle = { clear: () => void; stop: () => void };

// ---------------------------------------------------------------------------
// Tabbed shell: several independent terminals, only the active one visible.
// ---------------------------------------------------------------------------

type Tab = { id: string; name: string };

export function TerminalPanel({ onClose }: { onClose: () => void }) {
  const [tabs, setTabs] = useState<Tab[]>([{ id: "t1", name: "Terminal" }]);
  const [activeId, setActiveId] = useState("t1");
  const [running, setRunning] = useState<Set<string>>(new Set());
  const counter = useRef(1);
  const handles = useRef(new Map<string, InstanceHandle>());

  const register = useCallback((id: string, handle: InstanceHandle | null) => {
    if (handle) handles.current.set(id, handle);
    else handles.current.delete(id);
  }, []);

  const onRunningChange = useCallback((id: string, isRunning: boolean) => {
    setRunning((previous) => {
      if (previous.has(id) === isRunning) return previous;
      const next = new Set(previous);
      if (isRunning) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  function addTab() {
    counter.current += 1;
    const id = `t${counter.current}`;
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

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-vs-terminal">
      <header className="flex h-9 shrink-0 items-center gap-1 border-b border-vs-border bg-vs-terminal-head px-2">
        <div className="vs-scroll flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
          {tabs.map((tab) => (
            <TabButton
              key={tab.id}
              tab={tab}
              active={tab.id === activeId}
              running={running.has(tab.id)}
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
          {running.has(activeId) && (
            <button
              type="button"
              onClick={() => handles.current.get(activeId)?.stop()}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-vs-muted transition hover:bg-vs-hover hover:text-vs-fg"
            >
              <SpinnerIcon className="h-3 w-3" />
              Stop
            </button>
          )}
          <button
            type="button"
            onClick={() => handles.current.get(activeId)?.clear()}
            title="Clear (Ctrl+L)"
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

      {tabs.map((tab) => (
        <div
          key={tab.id}
          className={tab.id === activeId ? "flex min-h-0 flex-1 flex-col" : "hidden"}
        >
          <TerminalInstance id={tab.id} register={register} onRunningChange={onRunningChange} />
        </div>
      ))}
    </section>
  );
}

function TabButton({
  tab,
  active,
  running,
  closable,
  onSelect,
  onClose,
}: {
  tab: Tab;
  active: boolean;
  running: boolean;
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
        {running ? (
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 [animation:pulse_1.2s_ease-in-out_infinite]" />
        ) : (
          <TerminalIcon className={`h-3.5 w-3.5 ${active ? "text-vs-accent" : ""}`} />
        )}
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

// ---------------------------------------------------------------------------
// One terminal: its own scrollback, cwd, history and in-flight command.
// ---------------------------------------------------------------------------

function TerminalInstance({
  id,
  register,
  onRunningChange,
}: {
  id: string;
  register: (id: string, handle: InstanceHandle | null) => void;
  onRunningChange: (id: string, running: boolean) => void;
}) {
  const [status, setStatus] = useState<TerminalStatus | null>(null);
  const [cwd, setCwd] = useState("");
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [draft, setDraft] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const frameRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const activeRunIdRef = useRef<string | null>(null);
  const stickToBottomRef = useRef(true);

  useEffect(() => {
    let cancelled = false;
    fetchTerminalStatus()
      .then((next) => {
        if (cancelled) return;
        setStatus(next);
        setCwd(next.cwd);
      })
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

  // Abort any in-flight run when the terminal unmounts.
  useEffect(() => () => abortRef.current?.abort(), []);

  // Expose clear/stop to the shared header, and report the running state up so
  // the tab can show a live indicator.
  useEffect(() => {
    register(id, {
      clear: () => setBlocks([]),
      stop: () => {
        const runId = activeRunIdRef.current;
        if (runId) void interruptRun(runId);
      },
    });
    return () => register(id, null);
  }, [id, register]);

  useEffect(() => {
    activeRunIdRef.current = activeRunId;
    onRunningChange(id, activeRunId !== null);
  }, [activeRunId, id, onRunningChange]);

  // Follow the output while it streams, unless the user scrolled up to read.
  useEffect(() => {
    const element = scrollRef.current;
    if (element && stickToBottomRef.current) element.scrollTop = element.scrollHeight;
  }, [blocks]);

  /**
   * Output arrives in many small chunks. Each one is written into the block's
   * AnsiBuffer immediately, and a single re-render is scheduled per frame.
   */
  function scheduleRender() {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      setBlocks((previous) => [...previous]);
    });
  }

  function patch(blockId: string, changes: Partial<Block>) {
    setBlocks((previous) =>
      previous.map((block) => (block.id === blockId ? { ...block, ...changes } : block)),
    );
  }

  async function submit(command: string) {
    const trimmed = command.trim();
    if (!trimmed || activeRunId) return;

    setDraft("");
    setHistoryIndex(null);
    setHistory((previous) =>
      previous[previous.length - 1] === trimmed ? previous : [...previous, trimmed],
    );

    if (trimmed === "clear" || trimmed === "cls") {
      setBlocks([]);
      return;
    }

    const runId = crypto.randomUUID();
    const block: Block = {
      id: runId,
      command: trimmed,
      cwd,
      output: new AnsiBuffer(),
      notices: [],
      running: true,
      exitCode: null,
      signal: null,
      ms: 0,
    };

    setBlocks((previous) => [...previous.slice(-(MAX_BLOCKS - 1)), block]);
    setActiveRunId(runId);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await runCommand({
        command: trimmed,
        cwd,
        runId,
        signal: controller.signal,
        onEvent: (event) => {
          switch (event.t) {
            case "out":
            case "err":
              block.output.write(event.d);
              scheduleRender();
              break;
            case "cwd":
              setCwd(event.path);
              break;
            case "notice":
              block.notices.push(event.message);
              scheduleRender();
              break;
            case "exit":
              patch(runId, {
                running: false,
                exitCode: event.code,
                signal: event.signal,
                ms: event.ms,
              });
              break;
            default:
              break;
          }
        },
      });
    } catch (cause) {
      const aborted = cause instanceof DOMException && cause.name === "AbortError";
      patch(runId, {
        running: false,
        failure: aborted
          ? "Stopped."
          : cause instanceof Error
            ? cause.message
            : "The command failed to run.",
      });
    } finally {
      abortRef.current = null;
      setActiveRunId(null);
      inputRef.current?.focus();
    }
  }

  async function stop() {
    if (!activeRunId) return;
    await interruptRun(activeRunId);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      void submit(draft);
      return;
    }

    if (event.key === "c" && event.ctrlKey) {
      event.preventDefault();
      void stop();
      return;
    }

    if (event.key === "l" && event.ctrlKey) {
      event.preventDefault();
      setBlocks([]);
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (history.length === 0) return;
      const next = historyIndex === null ? history.length - 1 : Math.max(0, historyIndex - 1);
      setHistoryIndex(next);
      setDraft(history[next]);
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (historyIndex === null) return;
      const next = historyIndex + 1;
      if (next >= history.length) {
        setHistoryIndex(null);
        setDraft("");
        return;
      }
      setHistoryIndex(next);
      setDraft(history[next]);
    }
  }

  const disabled = status !== null && !status.enabled;

  if (disabled) {
    return (
      <div className="flex flex-1 items-center justify-center bg-vs-terminal px-6">
        <p className="flex max-w-md items-start gap-2 text-xs leading-5 text-vs-muted">
          <AlertIcon className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
          {status?.reason}
        </p>
      </div>
    );
  }

  return (
    <>
      <div
        ref={scrollRef}
        onClick={() => inputRef.current?.focus()}
        onScroll={(event) => {
          const element = event.currentTarget;
          stickToBottomRef.current =
            element.scrollHeight - element.scrollTop - element.clientHeight < 40;
        }}
        className="vs-scroll min-h-0 flex-1 overflow-auto bg-vs-terminal px-3 py-2 font-mono text-[12.5px] leading-[18px]"
        style={{ tabSize: 4 }}
      >
        {blocks.length === 0 && (
          <p className="max-w-xl text-[11px] leading-5 text-vs-muted">
            Commands run through {status?.shell ?? "your shell"} on the machine serving this app, in
            the directory below — not inside the folder you opened in the browser. Use{" "}
            <code className="rounded bg-vs-hover px-1">cd</code> to move around; it is remembered
            between commands.
          </p>
        )}

        {blocks.map((block) => (
          <BlockView key={block.id} block={block} />
        ))}
      </div>

      <div className="shrink-0 border-t border-vs-border bg-vs-terminal-head px-2 py-2">
        <div className="flex items-center gap-2 rounded-md border border-vs-border bg-vs-terminal px-2.5 py-1.5 font-mono text-[12.5px] focus-within:border-vs-accent">
          <CwdField cwd={cwd} disabled={!!activeRunId} onSubmit={(next) => submit(`cd ${next}`)} />
          <span className="shrink-0 text-emerald-500">➜</span>
          <input
            ref={inputRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            disabled={status === null || !!activeRunId}
            placeholder={activeRunId ? "running… press Ctrl+C to stop" : "npm test"}
            spellCheck={false}
            autoComplete="off"
            className="min-w-0 flex-1 bg-transparent text-vs-fg outline-none placeholder:text-vs-muted disabled:placeholder:text-vs-muted/70"
          />
          {activeRunId && <SpinnerIcon className="h-3.5 w-3.5 shrink-0 text-vs-muted" />}
        </div>
      </div>
    </>
  );
}

function BlockView({ block }: { block: Block }) {
  const { lines } = block.output.snapshot();
  // A trailing empty line is just the newline that ended the last row.
  const rendered =
    lines.length > 1 && lines[lines.length - 1].length === 0 ? lines.slice(0, -1) : lines;
  const hasOutput = rendered.some((line) => line.length > 0);

  return (
    <div className="mt-2.5 border-t border-vs-border/60 pt-2.5 first:mt-0 first:border-t-0 first:pt-0">
      <div className="flex items-baseline gap-2">
        <span className="shrink-0 text-emerald-500">➜</span>
        <span className="shrink-0 text-cyan-500 dark:text-cyan-400">{lastSegment(block.cwd)}</span>
        <span className="whitespace-pre-wrap break-all font-medium text-vs-fg">{block.command}</span>
        {block.running && <SpinnerIcon className="ml-1 h-3 w-3 shrink-0 text-vs-muted" />}
      </div>

      {hasOutput && (
        <pre className="whitespace-pre-wrap break-all text-vs-fg/90">
          {rendered.map((line, index) => (
            <div key={index}>
              {line.length === 0 ? " " : line.map((segment, at) => <SegmentView key={at} segment={segment} />)}
            </div>
          ))}
        </pre>
      )}

      {block.notices.map((notice) => (
        <p key={notice} className="flex items-start gap-1.5 text-[11px] text-amber-600 dark:text-amber-400">
          <AlertIcon className="mt-0.5 h-3 w-3 shrink-0" />
          {notice}
        </p>
      ))}

      {block.failure && <p className="text-[11px] text-vs-muted">{block.failure}</p>}

      {!block.running && !block.failure && (
        <p className="mt-1 flex items-center gap-1.5 text-[11px]">
          <span
            className={`rounded px-1.5 py-0.5 font-medium ${
              block.signal
                ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                : block.exitCode === 0
                  ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                  : "bg-red-500/15 text-red-600 dark:text-red-400"
            }`}
          >
            {block.signal ? block.signal : block.exitCode === 0 ? "exit 0" : `exit ${block.exitCode ?? "?"}`}
          </span>
          {block.ms > 0 && <span className="text-vs-muted">{formatDuration(block.ms)}</span>}
        </p>
      )}
    </div>
  );
}

function SegmentView({ segment }: { segment: Segment }) {
  const classes = [
    segment.className,
    segment.bold ? "font-bold" : "",
    segment.dim ? "opacity-60" : "",
    segment.italic ? "italic" : "",
    segment.underline ? "underline" : "",
  ]
    .filter(Boolean)
    .join(" ");

  if (!classes && !segment.color && !segment.background) return <>{segment.text}</>;

  return (
    <span
      className={classes || undefined}
      style={{ color: segment.color, background: segment.background }}
    >
      {segment.text}
    </span>
  );
}

function CwdField({
  cwd,
  disabled,
  onSubmit,
}: {
  cwd: string;
  disabled: boolean;
  onSubmit: (path: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(cwd);

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => {
          setValue(cwd);
          setEditing(true);
        }}
        disabled={disabled}
        title={`${cwd} — click to change`}
        className="max-w-64 shrink-0 truncate text-vs-muted transition hover:text-vs-fg disabled:hover:text-vs-muted"
      >
        {shortenPath(cwd)}
      </button>
    );
  }

  return (
    <input
      autoFocus
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => setEditing(false)}
      onKeyDown={(event) => {
        if (event.key === "Escape") setEditing(false);
        if (event.key !== "Enter") return;
        event.preventDefault();
        setEditing(false);
        if (value.trim() && value.trim() !== cwd) onSubmit(value.trim());
      }}
      spellCheck={false}
      className="min-w-0 flex-1 rounded border border-vs-accent bg-vs-editor px-1.5 py-0.5 text-vs-fg outline-none"
    />
  );
}

function lastSegment(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || "/";
}

function shortenPath(path: string): string {
  const home = path.match(/^(\/Users\/[^/]+|\/home\/[^/]+)(\/.*)?$/);
  return home ? `~${home[2] ?? ""}` : path;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}
