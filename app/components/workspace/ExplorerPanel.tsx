"use client";

import { useEffect, useState } from "react";
import { treeToText } from "../../lib/ascii";
import { humanBytes, humanCount, relativeTime } from "../../lib/format";
import { shortRemote } from "../../lib/git";
import { IGNORED_DIRS } from "../../lib/scan";
import type { ScanResult } from "../../lib/types";
import { AlertIcon, ChevronIcon, GitBranchIcon, SearchIcon, SpinnerIcon } from "../icons";
import { defaultExpanded, ExplorerTree } from "./ExplorerTree";
import { useAddFiles, type AddFilesFn } from "./AddFiles";
import { ChangesList, ListGlyph, StackGlyph, TreeGlyph, type ChangesLayout } from "./ChangesList";
import { ChangesReview } from "./ChangesReview";
import type { RoomChanges } from "./useRoomChanges";

type ExplorerPanelProps = {
  actionsRef?: (node: HTMLDivElement | null) => void;
  result: ScanResult;
  activePath: string | null;
  scanning: boolean;
  error?: string | null;
  onRefresh?: () => void;
  onImport?: () => void;
  repositories?: { id: string; label: string }[];
  onSelectRepository?: (id: string) => void;
  includeIgnored: boolean;
  /** False once the tree comes from the session repo rather than local disk. */
  canRescan: boolean;
  onToggleIgnored: (value: boolean) => void;
  onOpenFile: (path: string) => void;
  editing: Map<string, import("./usePeople").FilePresence[]>;
  /** When set, an "All files / Changes" switcher backed by this session's diff. */
  sessionId?: string;
  repoId?: string | null;
  /** When set (editors), New file / New folder / Upload files and drag-and-drop. */
  onAddFiles?: AddFilesFn;
  /** This repository's changes since import (with `sessionId`). */
  changes?: RoomChanges;
  /** Show a changed file's diff in the editor; without it, the review page opens. */
  onOpenDiff?: (path: string) => void;
};

export function ExplorerPanel({
  actionsRef,
  result,
  activePath,
  scanning,
  error,
  onRefresh,
  onImport,
  repositories = [],
  onSelectRepository,
  includeIgnored,
  canRescan,
  onToggleIgnored,
  onOpenFile,
  editing,
  sessionId,
  repoId = null,
  onAddFiles,
  changes: room,
  onOpenDiff,
}: ExplorerPanelProps) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(() => defaultExpanded(result.root));
  const [view, setView] = useState<"files" | "changes">("files");
  // null: closed; "" opens at the first file.
  const [reviewing, setReviewing] = useState<string | null>(null);
  const changes = room?.data ?? null;
  const [layout, setLayout] = useState<ChangesLayout>("list");
  const [filter, setFilter] = useState<string | null>(null);
  useEffect(() => {
    try { if (localStorage.getItem(LAYOUT_KEY) === "tree") void Promise.resolve().then(() => setLayout("tree")); } catch { /* storage unavailable */ }
  }, []);
  function toggleLayout() {
    const next = layout === "list" ? "tree" : "list";
    setLayout(next);
    try { localStorage.setItem(LAYOUT_KEY, next); } catch { /* storage unavailable */ }
  }
  const changeCount = changes?.changes.length ?? 0;
  const adding = useAddFiles({
    root: result.root,
    activePath,
    onAdd: onAddFiles ?? (async () => ({ added: [], replaced: [] })),
    onOpenFile,
    // Show where new things landed: open the folder and its parents.
    onExpand: (folder) => setExpanded((previous) => {
      const next = new Set(previous);
      folder.split("/").forEach((_, index, parts) => next.add(parts.slice(0, index + 1).join("/")));
      return next;
    }),
  });

  function toggle(path: string) {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  return (
    <aside aria-label="Repository explorer" aria-busy={scanning} className="flex h-full min-h-0 w-full flex-col bg-vs-editor">
      {sessionId && (
        <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-vs-border px-2 py-1.5">
          <div role="tablist" aria-label="Explorer view" className="flex items-center gap-0.5">
            <TabButton active={view === "files"} onClick={() => setView("files")}>
              All files
            </TabButton>
            <TabButton active={view === "changes"} onClick={() => setView("changes")}>
              Changes
              {changeCount > 0 && <span className="rounded-full bg-vs-accent/15 px-1.5 tabular-nums text-vs-accent">{changeCount}</span>}
              {changes?.live ? <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-vs-accent" title="An agent is changing files" /> : null}
            </TabButton>
          </div>
          {onRefresh && view === "files" && (
            <button type="button" onClick={onRefresh} disabled={scanning} aria-label="Refresh files" title="Refresh"
              className="rounded-md p-1 text-vs-muted transition hover:bg-vs-hover hover:text-vs-fg disabled:opacity-50">
              <RefreshGlyph spinning={scanning} />
            </button>
          )}
          <div ref={actionsRef} className="file-actions ml-auto flex items-center gap-1" />
        </div>
      )}

      {error && <p role="alert" className="px-3 py-2 text-xs text-vs-danger">{error}</p>}
      {room?.error && view === "changes" && <p role="alert" className="px-3 py-2 text-xs text-vs-danger">{room.error}</p>}
      {view === "files" ? (
        <>
          <div className="shrink-0 px-2 py-1.5">
            <label className="relative flex items-center">
              <SearchIcon className="pointer-events-none absolute left-2 h-3.5 w-3.5 text-vs-muted" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                aria-label="Filter files"
                placeholder="Find a file or folder…"
                className="w-full rounded border border-vs-border bg-vs-editor py-1 pl-7 pr-7 text-xs text-vs-fg outline-none placeholder:text-vs-muted focus:border-vs-accent"
              />
              {query && <button type="button" aria-label="Clear file filter" onClick={() => setQuery("")} className="absolute right-2 text-vs-muted hover:text-vs-fg">×</button>}
            </label>
          </div>

          <div className="flex shrink-0 items-center gap-1.5 px-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-vs-fg">
            <span className="truncate" title={result.rootName}>{result.rootName}</span>
            <span className="ml-auto shrink-0 text-[10px] font-normal normal-case text-vs-muted">{humanCount(result.stats.files)} {result.stats.files === 1 ? "file" : "files"}</span>
            {scanning && <SpinnerIcon className="h-3 w-3 text-vs-muted" />}
            {onAddFiles && adding.toolbar}
          </div>
          {onAddFiles && adding.inline}
          {onAddFiles && adding.error && <p role="alert" className="mx-3 mb-1.5 text-[11px] text-vs-danger">{adding.error}</p>}

          <div
            {...(onAddFiles ? adding.dropProps : {})}
            className={`vs-scroll min-h-0 flex-1 overflow-auto ${onAddFiles && adding.dragging ? "rounded-md outline-dashed outline-2 -outline-offset-4 outline-vs-accent bg-vs-accent/5" : ""}`}
          >
            {result.stats.files === 0 && !error && !scanning && <div className="m-3 rounded-xl border border-dashed border-vs-border p-3 text-xs leading-5 text-vs-muted">
              <p className="font-medium text-vs-fg">No files yet — you can start chatting</p>
              {repositories.length > 0 && onSelectRepository && <div className="my-2.5 space-y-1">
                <p className="text-[11px]">Other repositories in this room:</p>
                {repositories.map(repository => <button type="button" key={repository.id} onClick={() => onSelectRepository(repository.id)} className="block w-full truncate rounded-lg border border-vs-border px-2 py-1 text-left text-[11px] text-vs-fg hover:bg-vs-hover">Open {repository.label}</button>)}
              </div>}
              <p className="mt-1">Files are optional. Use the conversation to ask questions, or ask AI to create your first files here.</p>
              {onAddFiles && <p className="mt-1">Add your own with the <span className="text-vs-fg">New file</span>, <span className="text-vs-fg">New folder</span> and <span className="text-vs-fg">Upload files</span> buttons above, or drop files here.</p>}
              {onImport && <p className="mt-1">Have existing code? Import a folder as a separate project.</p>}
              {onImport && <button type="button" onClick={onImport} className="mt-2.5 rounded-lg bg-vs-accent px-2.5 py-1 text-[11px] font-medium text-vs-accent-fg">Import project files</button>}
            </div>}
            <ExplorerTree
              root={result.root}
              activePath={activePath}
              query={query}
              expanded={expanded}
              onToggle={toggle}
              onOpenFile={onOpenFile}
              editing={editing}
              changes={room?.byPath}
            />
          </div>
        </>
      ) : room?.error ? <div className="min-h-0 flex-1" /> : (
        <ChangesList
          data={changes}
          loading={!!room?.loading}
          activePath={activePath}
          toolbar={
            <div className="flex items-center gap-0.5">
              <IconButton label="Review all changes" disabled={changeCount === 0} onClick={() => setReviewing("")}><StackGlyph /></IconButton>
              <IconButton label="Filter changed files" pressed={filter !== null} onClick={() => setFilter(filter === null ? "" : null)}>
                <svg viewBox="0 0 16 16" aria-hidden className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><circle cx="7" cy="7" r="4.25" /><path d="m10.25 10.25 3.25 3.25" /></svg>
              </IconButton>
              <IconButton label={layout === "list" ? "Show as tree" : "Show as list"} onClick={toggleLayout}>{layout === "list" ? <TreeGlyph /> : <ListGlyph />}</IconButton>
            </div>
          }
          layout={layout}
          filter={filter}
          onFilter={setFilter}
          viewed={(file) => !!room?.isViewed(file)}
          onOpenDiff={(path) => (onOpenDiff ? onOpenDiff(path) : setReviewing(path))}
          onOpenFile={onOpenFile}
        />
      )}
      {sessionId && room && changes && reviewing !== null && (
        <ChangesReview
          sessionId={sessionId}
          repoId={repoId}
          data={changes}
          focusPath={reviewing || null}
          viewed={room.viewed}
          onToggleViewed={room.toggleViewed}
          onOpenFile={onOpenFile}
          onClose={() => setReviewing(null)}
        />
      )}

      {onAddFiles && adding.dialog}
      <RepoInfo
        result={result}
        includeIgnored={includeIgnored}
        canRescan={canRescan}
        onToggleIgnored={onToggleIgnored}
      />
    </aside>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      onClick={onClick}
      aria-selected={active}
      className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[13px] transition ${
        active ? "bg-vs-hover text-vs-fg" : "text-vs-muted hover:text-vs-fg"
      }`}
    >
      {children}
    </button>
  );
}

function IconButton({ label, onClick, pressed, disabled, children }: { label: string; onClick: () => void; pressed?: boolean; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} aria-label={label} title={label} aria-pressed={pressed}
      className={`rounded-md p-1.5 transition hover:bg-vs-hover hover:text-vs-fg disabled:opacity-40 ${pressed ? "bg-vs-hover text-vs-fg" : "text-vs-muted"}`}>
      {children}
    </button>
  );
}

const LAYOUT_KEY = "multicode:changes-layout";

function RefreshGlyph({ spinning }: { spinning: boolean }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={`h-3.5 w-3.5 ${spinning ? "animate-spin" : ""}`} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" />
    </svg>
  );
}

function RepoInfo({
  result,
  includeIgnored,
  canRescan,
  onToggleIgnored,
}: {
  result: ScanResult;
  includeIgnored: boolean;
  canRescan: boolean;
  onToggleIgnored: (value: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const { git, stats } = result;
  const notices = noticesFor(result);

  return (
    <section className="shrink-0 border-t border-vs-border">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-1.5 px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-vs-muted transition hover:bg-vs-hover hover:text-vs-fg"
      >
        <ChevronIcon className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-90" : ""}`} />
        Repository
        {notices.length > 0 && (
          <AlertIcon className="ml-auto h-3.5 w-3.5 text-vs-warn" />
        )}
      </button>

      {open && (
        <div className="space-y-2 px-3 pb-3 text-[11px] text-vs-muted">
          <p className="flex items-center gap-1.5">
            {git.isGit ? (
              <>
                <GitBranchIcon className="h-3.5 w-3.5 text-vs-accent" />
                <span className="font-mono text-vs-fg">
                  {git.branch ?? (git.detached ? "detached HEAD" : "unknown")}
                </span>
              </>
            ) : (
              <span>Plain folder — not a Git repository</span>
            )}
          </p>

          <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
            <Row label="Files" value={humanCount(stats.files)} />
            <Row label="Folders" value={humanCount(stats.dirs)} />
            <Row label="Size" value={humanBytes(stats.bytes)} />
            {git.isGit && <Row label="Branches" value={humanCount(git.branches.length)} />}
            {git.commit && <Row label="HEAD" value={git.commit.slice(0, 8)} mono />}
            {git.remotes[0] && (
              <Row label="Remote" value={shortRemote(git.remotes[0].url)} title={git.remotes[0].url} />
            )}
          </dl>

          {git.lastActivity && (
            <p className="truncate" title={git.lastActivity.message}>
              Last: {git.lastActivity.message} · {relativeTime(git.lastActivity.timestamp)}
            </p>
          )}

          {stats.topTypes.length > 0 && (
            <p className="flex flex-wrap gap-1">
              {stats.topTypes.map((type) => (
                <span key={type.ext} className="rounded bg-vs-hover px-1.5 py-0.5 font-mono">
                  .{type.ext} {humanCount(type.count)}
                </span>
              ))}
            </p>
          )}

          {canRescan ? (
            <label className="flex items-start gap-1.5 pt-1">
              <input
                type="checkbox"
                checked={includeIgnored}
                onChange={(event) => onToggleIgnored(event.target.checked)}
                className="mt-0.5 h-3 w-3 accent-vs-accent"
              />
              <span>Scan build &amp; dependency folders ({IGNORED_DIRS.size} skipped)</span>
            </label>
          ) : (
            <p className="pt-1 leading-4">
              Build and dependency folders were left out when this session was created. Changing
              that now would need a fresh session.
            </p>
          )}

          {notices.map((notice) => (
            <p key={notice} className="flex gap-1.5 leading-4">
              <AlertIcon className="mt-0.5 h-3 w-3 shrink-0 text-vs-warn" />
              {notice}
            </p>
          ))}

          <CopyStructureButton result={result} />
        </div>
      )}
    </section>
  );
}

/** Copies the tree as a `tree(1)`-style block — handy to paste into a prompt. */
function CopyStructureButton({ result }: { result: ScanResult }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(treeToText(result.root));
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      className="w-full rounded border border-vs-border py-1 text-[11px] text-vs-fg transition hover:bg-vs-hover"
    >
      {copied ? "Copied structure" : "Copy structure"}
    </button>
  );
}

function Row({
  label,
  value,
  mono,
  title,
}: {
  label: string;
  value: string;
  mono?: boolean;
  title?: string;
}) {
  return (
    <div className="min-w-0" title={title}>
      <dt className="text-[10px] uppercase tracking-wide">{label}</dt>
      <dd className={`truncate text-vs-fg ${mono ? "font-mono" : ""}`}>{value}</dd>
    </div>
  );
}

export function noticesFor(result: ScanResult): string[] {
  const notices: string[] = [];

  if (result.git.note) notices.push(result.git.note);

  if (!result.git.isGit && result.hiddenFilesUnavailable && result.source !== "picker") {
    notices.push(
      "No hidden files came through, so a .git folder could not be checked. Use “Open folder” for reliable Git detection.",
    );
  }
  if (result.stats.truncated) {
    notices.push("Scan stopped at 20,000 entries — the tree is partial.");
  }
  if (result.stats.skippedDirs > 0) {
    notices.push(
      `${result.stats.skippedDirs} folder(s) listed but not walked (.git plus build and dependency folders).`,
    );
  }

  return notices;
}
