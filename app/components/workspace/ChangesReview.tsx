"use client";

/*
 * Review changes: every changed file's diff on one page, the way a pull
 * request (or Conductor's diff panel) reads. A file list on the left jumps to
 * a file and shows which ones are viewed; diffs load as they scroll into view
 * and reload when the agent's next checkpoint changes them. Keys: j / k move
 * between files, v marks the current one viewed, o opens it in the editor.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { fetchChangeDiff } from "../../lib/session/remote";
import type { ChangedFile, ChangesResponse } from "../../lib/session/types";
import { CheckIcon, ChevronIcon, CloseIcon, SearchIcon, SpinnerIcon } from "../icons";
import { DiffView } from "./DiffView";
import { ChangeCounts, LivePill, STATUS_META, splitPath } from "./ChangesList";
import { FileTypeIcon } from "./FileTypeIcon";

import { viewedKey } from "./useRoomChanges";

type Props = {
  sessionId: string;
  repoId: string | null;
  data: ChangesResponse;
  focusPath: string | null;
  viewed: Set<string>;
  onToggleViewed: (file: ChangedFile) => void;
  onOpenFile: (path: string) => void;
  onClose: () => void;
};

export function ChangesReview({ sessionId, repoId, data, focusPath, viewed, onToggleViewed, onOpenFile, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState("");
  const [current, setCurrent] = useState<string | null>(focusPath ?? data.changes[0]?.path ?? null);
  const files = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return needle ? data.changes.filter((file) => file.path.toLowerCase().includes(needle)) : data.changes;
  }, [data.changes, filter]);
  const viewedCount = data.changes.filter((file) => viewed.has(viewedKey(file))).length;

  useEffect(() => {
    const node = dialog.current;
    const previous = document.activeElement;
    node?.showModal();
    return () => {
      node?.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  function jump(path: string) {
    setCurrent(path);
    scroller.current?.querySelector<HTMLElement>(`[data-diff-path="${CSS.escape(path)}"]`)?.scrollIntoView({ block: "start" });
  }

  // Opened from a file in the list: start at that file.
  useEffect(() => {
    if (focusPath) requestAnimationFrame(() => jump(focusPath));
  }, [focusPath]);

  function onKeyDown(event: React.KeyboardEvent) {
    const target = event.target as HTMLElement;
    if (event.metaKey || event.ctrlKey || event.altKey || target.closest("input, textarea, select, [contenteditable]")) return;
    const at = files.findIndex((file) => file.path === current);
    const file = files[at];
    if (event.key === "j" || event.key === "k") {
      const next = files[Math.min(files.length - 1, Math.max(0, at + (event.key === "j" ? 1 : -1)))];
      if (next) jump(next.path);
    } else if (event.key === "v" && file) onToggleViewed(file);
    else if (event.key === "o" && file && file.status !== "D") { onOpenFile(file.path); onClose(); }
    else return;
    event.preventDefault();
  }

  const totals = data.totals ?? { files: data.changes.length, added: 0, removed: 0 };
  return (
    <dialog
      ref={dialog}
      aria-label="Review changes"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onKeyDown={onKeyDown}
      className="m-0 h-dvh max-h-none w-screen max-w-none bg-vs-bg p-0 text-vs-fg backdrop:bg-black/40"
    >
      <div className="flex h-full min-h-0 flex-col">
        <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-vs-border px-4 py-2.5">
          <h2 className="text-sm font-semibold">Review changes</h2>
          <span className="text-xs text-vs-muted">{totals.files} {totals.files === 1 ? "file" : "files"}</span>
          <ChangeCounts added={totals.added} removed={totals.removed} />
          {data.live && <LivePill live={data.live} />}
          <span className="ml-auto text-xs text-vs-muted" aria-live="polite">{viewedCount} of {data.changes.length} viewed</span>
          <span className="hidden text-[11px] text-vs-muted lg:inline"><Key>j</Key> <Key>k</Key> move · <Key>v</Key> viewed · <Key>o</Key> open</span>
          <button type="button" onClick={onClose} aria-label="Close review" className="rounded-md p-1 text-vs-muted hover:bg-vs-hover hover:text-vs-fg">
            <CloseIcon className="h-4 w-4" />
          </button>
        </header>

        <div className="flex min-h-0 flex-1">
          <nav aria-label="Changed files" className="hidden w-72 shrink-0 flex-col border-r border-vs-border md:flex">
            <label className="flex items-center gap-2 border-b border-vs-border px-3 py-2">
              <SearchIcon className="h-3.5 w-3.5 text-vs-muted" />
              <span className="sr-only">Filter changed files</span>
              <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter files…" className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-vs-muted" />
            </label>
            <ul className="vs-scroll min-h-0 flex-1 overflow-auto py-1">
              {files.map((file) => {
                const { dir, name } = splitPath(file.path);
                const seen = viewed.has(viewedKey(file));
                return (
                  <li key={file.path}>
                    <button
                      type="button"
                      onClick={() => jump(file.path)}
                      aria-current={file.path === current ? "true" : undefined}
                      title={file.path}
                      className={`flex w-full items-center gap-2 px-3 py-1 text-left text-[12px] ${file.path === current ? "bg-vs-active" : "hover:bg-vs-hover"} ${seen ? "opacity-60" : ""}`}
                    >
                      <FileTypeIcon name={file.path} />
                      <span className="min-w-0 flex-1 truncate">
                        <span className={`font-medium ${STATUS_META[file.status].name}`}>{name}</span>
                        {dir && <span className="ml-1.5 text-[11px] text-vs-muted">{dir}</span>}
                      </span>
                      {seen ? <CheckIcon className="h-3.5 w-3.5 shrink-0 text-vs-success" /> : <ChangeCounts added={file.added} removed={file.removed} binary={file.binary} compact />}
                      <span className={`w-3 shrink-0 text-center font-mono text-[11px] font-bold ${STATUS_META[file.status].className}`}>{file.status}</span>
                    </button>
                  </li>
                );
              })}
              {files.length === 0 && <li className="px-3 py-4 text-center text-xs text-vs-muted">No files match.</li>}
            </ul>
          </nav>

          {/* Focused on open, so the keys and arrow scrolling work right away. */}
          <div ref={scroller} tabIndex={-1} autoFocus className="vs-scroll min-h-0 min-w-0 flex-1 space-y-3 overflow-auto p-3 outline-none sm:p-4">
            {files.map((file) => (
              <FileDiff
                key={file.path}
                sessionId={sessionId}
                repoId={repoId}
                head={data.head ?? ""}
                file={file}
                current={file.path === current}
                viewed={viewed.has(viewedKey(file))}
                scroller={scroller}
                onFocus={() => setCurrent(file.path)}
                onToggleViewed={() => onToggleViewed(file)}
                onOpen={() => { onOpenFile(file.path); onClose(); }}
              />
            ))}
          </div>
        </div>
      </div>
    </dialog>
  );
}

function FileDiff({ sessionId, repoId, head, file, current, viewed, scroller, onFocus, onToggleViewed, onOpen }: {
  sessionId: string;
  repoId: string | null;
  head: string;
  file: ChangedFile;
  current: boolean;
  viewed: boolean;
  scroller: React.RefObject<HTMLDivElement | null>;
  onFocus: () => void;
  onToggleViewed: () => void;
  onOpen: () => void;
}) {
  const node = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);
  // Marking a file viewed folds it away and unmarking brings it back; a
  // manual expand or collapse holds until the viewed mark changes.
  const [toggled, setToggled] = useState<{ viewed: boolean; open: boolean } | null>(null);
  const open = toggled?.viewed === viewed ? toggled.open : !viewed;
  const [diff, setDiff] = useState<{ head: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { dir, name } = splitPath(file.path);

  useEffect(() => {
    const element = node.current;
    if (!element) return;
    const observer = new IntersectionObserver(([entry]) => { if (entry?.isIntersecting) setVisible(true); }, { root: scroller.current, rootMargin: "800px 0px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [scroller]);

  const stale = diff?.head !== head;
  useEffect(() => {
    if (!visible || !open || !stale || file.binary) return;
    const controller = new AbortController();
    fetchChangeDiff(sessionId, repoId, file.path, controller.signal)
      .then((text) => { setDiff({ head, text }); setError(null); })
      .catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not load this file's changes."); });
    return () => controller.abort();
  }, [visible, open, stale, sessionId, repoId, file.path, file.binary, head]);

  return (
    <section ref={node} data-diff-path={file.path} aria-label={file.path} onClick={onFocus} className={`scroll-mt-3 overflow-hidden rounded-lg border bg-vs-panel ${current ? "border-vs-accent/60" : "border-vs-border"}`}>
      <header className="sticky top-0 z-10 flex items-center gap-2 border-b border-vs-border bg-vs-panel px-3 py-2">
        <button type="button" onClick={() => setToggled({ viewed, open: !open })} aria-expanded={open} aria-label={open ? `Collapse ${file.path}` : `Expand ${file.path}`} className="rounded p-0.5 text-vs-muted hover:bg-vs-hover">
          <ChevronIcon className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-90" : ""}`} />
        </button>
        <FileTypeIcon name={file.path} />
        <span className="min-w-0 flex-1 truncate font-mono text-[12px]" title={file.path}>
          {dir && <span className="text-vs-muted">{dir}/</span>}
          <span className={`font-semibold ${file.status === "D" ? "line-through" : ""}`}>{name}</span>
        </span>
        <span className={`rounded px-1.5 py-px text-[10.5px] font-medium ${STATUS_META[file.status].className} ${STATUS_META[file.status].badge}`}>{STATUS_META[file.status].label}</span>
        <ChangeCounts added={file.added} removed={file.removed} binary={file.binary} bar />
        {file.status !== "D" && <button type="button" onClick={onOpen} className="rounded-md px-2 py-0.5 text-xs text-vs-muted hover:bg-vs-hover hover:text-vs-fg">Open</button>}
        <label className="flex cursor-pointer items-center gap-1.5 rounded-md border border-vs-border px-2 py-0.5 text-xs text-vs-muted hover:text-vs-fg">
          <input type="checkbox" checked={viewed} onChange={onToggleViewed} className="h-3 w-3 accent-vs-accent" />
          Viewed
        </label>
      </header>
      {open && (
        file.binary ? <p className="px-3 py-3 text-xs text-vs-muted">Binary file. Git can’t show line changes for this kind of file; open it to see it.</p>
          : error ? <p role="alert" className="px-3 py-3 text-xs text-vs-danger">{error}</p>
          : diff ? <DiffView diff={diff.text} label={`Changes to ${file.path}`} path={file.path} bounded={false} />
            : <p className="flex items-center gap-2 px-3 py-3 text-xs text-vs-muted"><SpinnerIcon className="h-3.5 w-3.5" /> Loading diff…</p>
      )}
    </section>
  );
}

function Key({ children }: { children: React.ReactNode }) {
  return <kbd className="rounded border border-vs-border px-1 font-sans text-[10px]">{children}</kbd>;
}
