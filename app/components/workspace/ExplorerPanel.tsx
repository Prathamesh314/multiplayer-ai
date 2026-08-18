"use client";

import { useState } from "react";
import { treeToText } from "../../lib/ascii";
import { humanBytes, humanCount, relativeTime } from "../../lib/format";
import { shortRemote } from "../../lib/git";
import { IGNORED_DIRS } from "../../lib/scan";
import type { ScanResult } from "../../lib/types";
import { AlertIcon, ChevronIcon, GitBranchIcon, SearchIcon, SpinnerIcon } from "../icons";
import { defaultExpanded, ExplorerTree } from "./ExplorerTree";
import { PanelHeader } from "./TeamChatPanel";

type ExplorerPanelProps = {
  result: ScanResult;
  activePath: string | null;
  scanning: boolean;
  includeIgnored: boolean;
  /** False once the tree comes from the session repo rather than local disk. */
  canRescan: boolean;
  onToggleIgnored: (value: boolean) => void;
  onOpenFile: (path: string) => void;
  onOpenFolder: () => void;
  onClose: () => void;
};

export function ExplorerPanel({
  result,
  activePath,
  scanning,
  includeIgnored,
  canRescan,
  onToggleIgnored,
  onOpenFile,
  onOpenFolder,
  onClose,
}: ExplorerPanelProps) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(() => defaultExpanded(result.root));

  function toggle(path: string) {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  return (
    <aside className="flex h-full min-h-0 w-full flex-col bg-vs-panel">
      <PanelHeader title="Explorer" onClose={onClose}>
        <button
          type="button"
          onClick={() => setExpanded(new Set())}
          className="rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-vs-muted transition hover:bg-vs-hover hover:text-vs-fg"
        >
          Collapse
        </button>
        <button
          type="button"
          onClick={onOpenFolder}
          className="rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-vs-muted transition hover:bg-vs-hover hover:text-vs-fg"
        >
          Open
        </button>
      </PanelHeader>

      <div className="shrink-0 px-2 py-2">
        <label className="relative flex items-center">
          <SearchIcon className="pointer-events-none absolute left-2 h-3.5 w-3.5 text-vs-muted" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter files"
            className="w-full rounded border border-vs-border bg-vs-editor py-1 pl-7 pr-2 text-xs text-vs-fg outline-none placeholder:text-vs-muted focus:border-vs-accent"
          />
        </label>
      </div>

      <div className="flex shrink-0 items-center gap-1.5 px-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-vs-fg">
        <span className="truncate">{result.rootName}</span>
        {scanning && <SpinnerIcon className="h-3 w-3 text-vs-muted" />}
      </div>

      <div className="vs-scroll min-h-0 flex-1 overflow-auto">
        <ExplorerTree
          root={result.root}
          activePath={activePath}
          query={query}
          expanded={expanded}
          onToggle={toggle}
          onOpenFile={onOpenFile}
        />
      </div>

      <RepoInfo
        result={result}
        includeIgnored={includeIgnored}
        canRescan={canRescan}
        onToggleIgnored={onToggleIgnored}
      />
    </aside>
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
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-vs-muted transition hover:bg-vs-hover hover:text-vs-fg"
      >
        <ChevronIcon className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-90" : ""}`} />
        Repository
        {notices.length > 0 && (
          <AlertIcon className="ml-auto h-3.5 w-3.5 text-amber-500" />
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
              <AlertIcon className="mt-0.5 h-3 w-3 shrink-0 text-amber-500" />
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
