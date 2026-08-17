"use client";

import { useEffect, useRef, useState } from "react";
import { AnsiBuffer, type Segment } from "../../lib/terminal/ansi";
import { fetchTerminalStatus, interruptRun, runCommand } from "../../lib/terminal/client";
import type { TerminalStatus } from "../../lib/terminal/protocol";
import { AlertIcon, CloseIcon, SpinnerIcon } from "../icons";

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

export function TerminalPanel({ onClose }: { onClose: () => void }) {
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

  // Abort any in-flight run when the panel unmounts.
  useEffect(() => () => abortRef.current?.abort(), []);

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

  function patch(id: string, changes: Partial<Block>) {
    setBlocks((previous) =>
      previous.map((block) => (block.id === id ? { ...block, ...changes } : block)),
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

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-vs-panel">
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-vs-border px-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-vs-muted">
          Terminal
        </h2>
        {status?.shell && (
          <span className="truncate font-mono text-[11px] text-vs-muted">{status.shell}</span>
        )}

        <div className="ml-auto flex items-center gap-2">
          {activeRunId && (
            <button
              type="button"
              onClick={stop}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-vs-muted transition hover:bg-vs-hover hover:text-vs-fg"
            >
              <SpinnerIcon className="h-3 w-3" />
              Stop
            </button>
          )}
          <button
            type="button"
            onClick={() => setBlocks([])}
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
        <div className="flex flex-1 items-center justify-center px-6">
          <p className="flex max-w-md items-start gap-2 text-xs leading-5 text-vs-muted">
            <AlertIcon className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
            {status?.reason}
          </p>
        </div>
      ) : (
        <>
          <div
            ref={scrollRef}
            onClick={() => inputRef.current?.focus()}
            onScroll={(event) => {
              const element = event.currentTarget;
              stickToBottomRef.current =
                element.scrollHeight - element.scrollTop - element.clientHeight < 40;
            }}
            className="vs-scroll min-h-0 flex-1 overflow-auto px-3 py-2 font-mono text-[12.5px] leading-[18px]"
            style={{ tabSize: 4 }}
          >
            {blocks.length === 0 && (
              <p className="text-[11px] leading-5 text-vs-muted">
                Commands run through {status?.shell ?? "your shell"} on the machine serving this
                app, in the directory below — not inside the folder you opened in the browser. Use{" "}
                <code>cd</code> to move around; it is remembered between commands.
              </p>
            )}

            {blocks.map((block) => (
              <BlockView key={block.id} block={block} />
            ))}
          </div>

          <div className="shrink-0 border-t border-vs-border">
            <div className="flex items-center gap-2 px-3 py-1.5 font-mono text-[12.5px]">
              <CwdField cwd={cwd} disabled={!!activeRunId} onSubmit={(next) => submit(`cd ${next}`)} />
              <span className="shrink-0 text-vs-accent">❯</span>
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
            </div>
          </div>
        </>
      )}
    </section>
  );
}

function BlockView({ block }: { block: Block }) {
  const { lines } = block.output.snapshot();
  // A trailing empty line is just the newline that ended the last row.
  const rendered =
    lines.length > 1 && lines[lines.length - 1].length === 0 ? lines.slice(0, -1) : lines;
  const hasOutput = rendered.some((line) => line.length > 0);

  return (
    <div className="mt-2 first:mt-0">
      <div className="flex items-baseline gap-2">
        <span className="shrink-0 text-vs-muted">{lastSegment(block.cwd)}</span>
        <span className="shrink-0 text-vs-accent">❯</span>
        <span className="whitespace-pre-wrap break-all text-vs-fg">{block.command}</span>
        {block.running && <SpinnerIcon className="ml-1 h-3 w-3 shrink-0 text-vs-muted" />}
      </div>

      {hasOutput && (
        <pre className="whitespace-pre-wrap break-all text-vs-fg/90">
          {rendered.map((line, index) => (
            <div key={index}>
              {line.length === 0 ? " " : line.map((segment, at) => <SegmentView key={at} segment={segment} />)}
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
        <p className="text-[11px] text-vs-muted">
          {block.signal ? (
            <span className="text-amber-600 dark:text-amber-400">{block.signal}</span>
          ) : block.exitCode === 0 ? (
            "exit 0"
          ) : (
            <span className="text-red-600 dark:text-red-400">exit {block.exitCode ?? "?"}</span>
          )}
          {block.ms > 0 && ` · ${formatDuration(block.ms)}`}
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
