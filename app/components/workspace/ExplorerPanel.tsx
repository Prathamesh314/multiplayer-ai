"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { treeToText } from "../../lib/ascii";
import { humanBytes, humanCount, relativeTime } from "../../lib/format";
import { shortRemote } from "../../lib/git";
import { IGNORED_DIRS } from "../../lib/scan";
import { openSessionStream } from "../../lib/events/client";
import { fetchChanges } from "../../lib/session/remote";
import type { ChangedFile, ChangesResponse } from "../../lib/session/types";
import type { ScanResult } from "../../lib/types";
import { AlertIcon, ChevronIcon, GitBranchIcon, SearchIcon, SpinnerIcon } from "../icons";
import { defaultExpanded, ExplorerTree } from "./ExplorerTree";
import { useAddFiles, type AddFilesFn } from "./AddFiles";
import { ChangesList } from "./ChangesList";
import { ChangesReview, viewedKey } from "./ChangesReview";

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
}: ExplorerPanelProps) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(() => defaultExpanded(result.root));
  const [view, setView] = useState<"files" | "changes">("files");
  const [changes, setChanges] = useState<ChangesResponse | null>(null);
  const [viewed, setViewed] = useState<Set<string>>(() => new Set());
  // null: closed; "" opens at the first file.
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [changesError, setChangesError] = useState<string | null>(null);
  const [loadingChanges, setLoadingChanges] = useState(false);
  const changesRequest = useRef(0);
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

  const loadChanges = useCallback(async () => {
    if (!sessionId) return;
    const request = ++changesRequest.current;
    setLoadingChanges(true);
    try {
      setChangesError(null);
      const next = await fetchChanges(sessionId, repoId);
      if (request === changesRequest.current) setChanges(next);
    } catch (cause) {
      if (request === changesRequest.current) {
        setChanges(null);
        setChangesError(cause instanceof Error ? cause.message : "Could not load changes.");
      }
    } finally {
      if (request === changesRequest.current) setLoadingChanges(false);
    }
  }, [sessionId, repoId]);

  useEffect(() => {
    void Promise.resolve().then(loadChanges);
  }, [result.git.commit, loadChanges]);

  // Follow the work as it happens: an agent's checkpoints, finished turns and
  // teammates' saves all change what this tab shows. Bursts coalesce.
  useEffect(() => {
    if (!sessionId) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const changed = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { if (!document.hidden) void loadChanges(); }, 600);
    };
    const stream = openSessionStream(sessionId, {
      onRunActivity: changed,
      onRunFinished: changed,
      onRunBranch: changed,
      onFileSaved: changed,
      onStatus: (connected) => { if (connected) changed(); },
    });
    document.addEventListener("visibilitychange", changed);
    return () => { clearTimeout(timer); stream.close(); document.removeEventListener("visibilitychange", changed); };
  }, [sessionId, loadChanges]);

  function toggleViewed(file: ChangedFile) {
    setViewed((previous) => {
      const next = new Set(previous);
      const key = viewedKey(file);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <aside aria-label="Repository explorer" aria-busy={scanning} className="flex h-full min-h-0 w-full flex-col bg-vs-editor">
      {sessionId && (
        <div className="flex shrink-0 items-center gap-1 border-b border-vs-border px-2 py-1.5 flex-wrap">
          <TabButton active={view === "files"} onClick={() => setView("files")}>
            All files
          </TabButton>
          <TabButton active={view === "changes"} onClick={() => setView("changes")}>
            Changes
            {changes?.live ? (
              <span className="ml-1 h-1.5 w-1.5 animate-pulse rounded-full bg-vs-accent" title="An agent is changing files" />
            ) : null}
            {changes && changes.changes.length > 0 && (
              <span className="ml-1 rounded-full bg-vs-accent/15 px-1.5 text-[10px] text-vs-accent">
                {changes.changes.length}
              </span>
            )}
          </TabButton>
          {onRefresh && <button type="button" onClick={view === "changes" ? () => void loadChanges() : onRefresh} disabled={scanning || loadingChanges} aria-label="Refresh files" title="Refresh files" className="rounded px-1 text-vs-muted hover:bg-vs-hover">↻</button>}
          <div ref={actionsRef} className="file-actions ml-auto flex items-center gap-1" />
        </div>
      )}

      {error && <p role="alert" className="px-3 py-2 text-xs text-vs-danger">{error}</p>}
      {changesError && view === "changes" && <p role="alert" className="px-3 py-2 text-xs text-vs-danger">{changesError}</p>}
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
            />
          </div>
        </>
      ) : changesError ? <div className="min-h-0 flex-1" /> : (
        <ChangesList
          data={changes}
          loading={loadingChanges}
          activePath={activePath}
          viewed={(file) => viewed.has(viewedKey(file))}
          onReview={(path) => setReviewing(path ?? "")}
          onOpenFile={onOpenFile}
        />
      )}
      {sessionId && changes && reviewing !== null && (
        <ChangesReview
          sessionId={sessionId}
          repoId={repoId}
          data={changes}
          focusPath={reviewing || null}
          viewed={viewed}
          onToggleViewed={toggleViewed}
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
      onClick={onClick}
      aria-pressed={active}
      className={`flex items-center rounded px-1.5 py-0.5 text-xs transition ${
        active ? "bg-vs-hover font-medium text-vs-fg" : "text-vs-muted hover:text-vs-fg"
      }`}
    >
      {children}
    </button>
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
