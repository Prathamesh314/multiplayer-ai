"use client";

import { useEffect, useMemo, useState } from "react";
import { relativeTime } from "../../lib/format";
import type { ChangedFile, ChangesResponse } from "../../lib/session/types";
import { CheckIcon, ChevronIcon, FolderIcon, SpinnerIcon } from "../icons";
import { FileTypeIcon } from "./FileTypeIcon";

export const STATUS_META: Record<ChangedFile["status"], { label: string; className: string; badge: string; name: string }> = {
  A: { label: "Added", className: "text-vs-success", badge: "bg-vs-success/10", name: "text-vs-success" },
  M: { label: "Modified", className: "text-vs-warn", badge: "bg-vs-warn/10", name: "text-vs-warn" },
  D: { label: "Deleted", className: "text-vs-danger", badge: "bg-vs-danger/10", name: "text-vs-danger line-through decoration-vs-danger/50" },
  R: { label: "Renamed", className: "text-vs-accent", badge: "bg-vs-accent/10", name: "text-vs-accent" },
  C: { label: "Copied", className: "text-vs-accent", badge: "bg-vs-accent/10", name: "text-vs-accent" },
};

export function splitPath(path: string): { dir: string; name: string } {
  const at = path.lastIndexOf("/");
  return at < 0 ? { dir: "", name: path } : { dir: path.slice(0, at), name: path.slice(at + 1) };
}

/** "+12 −3", optionally with GitHub's five-block bar of the added/removed share. */
export function ChangeCounts({ added = 0, removed = 0, compact = false, bar = false, binary = false }: { added?: number; removed?: number; compact?: boolean; bar?: boolean; binary?: boolean }) {
  if (binary) return <span className="shrink-0 rounded border border-vs-border px-1 font-mono text-[9.5px] uppercase tracking-wide text-vs-muted" title="Binary file: no line counts">bin</span>;
  const total = added + removed;
  const green = total ? Math.round((added / total) * 5) : 0;
  return (
    <span className={`flex shrink-0 items-center gap-1.5 font-mono tabular-nums ${compact ? "text-[10.5px]" : "text-[11px]"}`} aria-label={`${added} lines added, ${removed} lines removed`}>
      {(added > 0 || !compact) && <span className="text-vs-success">+{added}</span>}
      {(removed > 0 || !compact) && <span className="text-vs-danger">−{removed}</span>}
      {bar && total > 0 && (
        <span aria-hidden className="flex gap-px">
          {Array.from({ length: 5 }, (_, index) => (
            <span key={index} className={`h-2 w-2 rounded-[2px] ${index < green ? "bg-vs-success" : index < (removed ? 5 : green) ? "bg-vs-danger" : "bg-vs-border"}`} />
          ))}
        </span>
      )}
    </span>
  );
}

/** An agent is working: these changes include its worktree as of its last checkpoint. */
export function LivePill({ live }: { live: NonNullable<ChangesResponse["live"]> }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5 rounded-full border border-vs-accent/30 bg-vs-accent/10 px-2 py-0.5 text-[11px] text-vs-accent" title={`Includes the agent's work in progress, saved ${relativeTime(live.capturedAt / 1000)}`}>
      <span className="relative flex h-1.5 w-1.5 shrink-0">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-60" />
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-current" />
      </span>
      <span className="truncate">Agent editing{live.title ? ` · ${live.title}` : ""}</span>
    </span>
  );
}

type Layout = "list" | "tree";
const LAYOUT_KEY = "multicode:changes-layout";

type Folder = { name: string; path: string; folders: Folder[]; files: ChangedFile[]; added: number; removed: number; count: number };

/** Folders of changed files, with single-child chains joined ("src/lib") the way VS Code compacts them. */
function buildTree(changes: ChangedFile[]): Folder {
  const root: Folder = { name: "", path: "", folders: [], files: [], added: 0, removed: 0, count: 0 };
  for (const file of changes) {
    const parts = file.path.split("/");
    let folder = root;
    const chain = [root];
    for (const part of parts.slice(0, -1)) {
      const path = folder.path ? `${folder.path}/${part}` : part;
      let next = folder.folders.find((candidate) => candidate.name === part);
      if (!next) { next = { name: part, path, folders: [], files: [], added: 0, removed: 0, count: 0 }; folder.folders.push(next); }
      folder = next;
      chain.push(folder);
    }
    folder.files.push(file);
    for (const parent of chain) { parent.added += file.added ?? 0; parent.removed += file.removed ?? 0; parent.count += 1; }
  }
  const compact = (folder: Folder): Folder => {
    let current = folder;
    while (current.folders.length === 1 && current.files.length === 0) {
      const only: Folder = current.folders[0]!;
      current = { ...only, name: `${current.name}/${only.name}` };
    }
    const sorted = (items: Folder[]) => [...items].sort((a, b) => a.name.localeCompare(b.name));
    return { ...current, folders: sorted(current.folders.map(compact)), files: [...current.files].sort((a, b) => a.path.localeCompare(b.path)) };
  };
  return { ...root, folders: [...root.folders].map(compact).sort((a, b) => a.name.localeCompare(b.name)), files: [...root.files].sort((a, b) => a.path.localeCompare(b.path)) };
}

/**
 * The explorer's Changes tab: what this repository changed since import, live
 * while an agent works. Choosing a file shows its diff beside the chat;
 * "Review all" stacks every diff on one page.
 */
export function ChangesList({
  data,
  loading,
  activePath,
  viewed,
  onOpenDiff,
  onOpenFile,
  onReview,
}: {
  data: ChangesResponse | null;
  loading: boolean;
  activePath: string | null;
  viewed: (file: ChangedFile) => boolean;
  onOpenDiff: (path: string) => void;
  onOpenFile: (path: string) => void;
  onReview: () => void;
}) {
  const [layout, setLayout] = useState<Layout>("list");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    try { if (localStorage.getItem(LAYOUT_KEY) === "tree") void Promise.resolve().then(() => setLayout("tree")); } catch { /* storage unavailable */ }
  }, []);
  function chooseLayout(next: Layout) {
    setLayout(next);
    try { localStorage.setItem(LAYOUT_KEY, next); } catch { /* storage unavailable */ }
  }

  const changes = useMemo(() => data?.changes ?? [], [data]);
  const tree = useMemo(() => buildTree(changes), [changes]);

  if (loading && data === null) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-sm text-vs-muted">
        <SpinnerIcon className="h-3.5 w-3.5" />
        Reading changes…
      </div>
    );
  }

  if (changes.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2.5 px-6 text-center">
        {data?.live ? <LivePill live={data.live} /> : (
          <span className="flex h-9 w-9 items-center justify-center rounded-full border border-vs-border bg-vs-panel"><CheckIcon className="h-4 w-4 text-vs-success" /></span>
        )}
        <p className="text-[13px] font-medium text-vs-fg">{data?.live ? "Waiting for the first file" : "No changes yet"}</p>
        <p className="max-w-56 text-xs leading-5 text-vs-muted">{data?.live ? "Files appear here as the agent writes them." : "Files you or an agent add, edit or delete appear here, compared with the imported version."}</p>
      </div>
    );
  }

  const totals = data?.totals ?? { files: changes.length, added: 0, removed: 0 };
  const lines = totals.added + totals.removed;
  const row = (change: ChangedFile, depth: number | null) => (
    <ChangeRow key={change.path} change={change} depth={depth} active={change.path === activePath} seen={viewed(change)} onOpenDiff={onOpenDiff} onOpenFile={onOpenFile} />
  );
  const folder = (item: Folder, depth: number): React.ReactNode => {
    const open = !collapsed.has(item.path);
    return (
      <li key={`dir:${item.path}`}>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setCollapsed((previous) => { const next = new Set(previous); if (next.has(item.path)) next.delete(item.path); else next.add(item.path); return next; })}
          style={{ paddingLeft: depth * 12 + 8 }}
          className="flex h-7 w-full items-center gap-1.5 pr-3 text-left text-[12.5px] text-vs-fg hover:bg-vs-hover"
          title={item.path}
        >
          <ChevronIcon className={`h-3 w-3 shrink-0 text-vs-muted transition-transform ${open ? "rotate-90" : ""}`} />
          <FolderIcon open={open} className="h-4 w-4 shrink-0 text-sky-500 dark:text-sky-400" />
          <span className="min-w-0 flex-1 truncate">{item.name}</span>
          <span className="shrink-0 text-[10.5px] tabular-nums text-vs-muted">{item.count}</span>
        </button>
        {open && <ul>{item.folders.map((child) => folder(child, depth + 1))}{item.files.map((file) => row(file, depth + 1))}</ul>}
      </li>
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 space-y-2 border-b border-vs-border px-3 py-2.5">
        <div className="flex items-center gap-2">
          <p className="text-[13px] font-semibold text-vs-fg">{totals.files} {totals.files === 1 ? "change" : "changes"}</p>
          <ChangeCounts added={totals.added} removed={totals.removed} />
          <div role="group" aria-label="Show changes as" className="ml-auto flex rounded-md border border-vs-border p-0.5">
            {(["list", "tree"] as const).map((option) => (
              <button key={option} type="button" aria-pressed={layout === option} aria-label={option === "list" ? "Show as list" : "Show as tree"} title={option === "list" ? "List" : "Tree"} onClick={() => chooseLayout(option)}
                className={`rounded px-1.5 py-0.5 ${layout === option ? "bg-vs-active text-vs-fg" : "text-vs-muted hover:text-vs-fg"}`}>
                {option === "list" ? <ListGlyph /> : <TreeGlyph />}
              </button>
            ))}
          </div>
        </div>
        {lines > 0 && (
          <div aria-hidden className="flex h-1 overflow-hidden rounded-full bg-vs-border">
            <span className="bg-vs-success" style={{ width: `${(totals.added / lines) * 100}%` }} />
            <span className="bg-vs-danger" style={{ width: `${(totals.removed / lines) * 100}%` }} />
          </div>
        )}
        {data?.live && <LivePill live={data.live} />}
        <button type="button" onClick={onReview} className="group flex w-full items-center justify-center gap-1.5 rounded-md border border-vs-accent/40 bg-vs-accent/10 px-2 py-1 text-xs font-medium text-vs-accent transition hover:bg-vs-accent/20">
          Review all changes
          <span aria-hidden className="transition-transform group-hover:translate-x-0.5">→</span>
        </button>
      </div>
      <ul className="vs-scroll min-h-0 flex-1 overflow-auto py-1" aria-label="Changed files">
        {layout === "list" ? [...changes].sort((a, b) => a.path.localeCompare(b.path)).map((change) => row(change, null)) : <>{tree.folders.map((item) => folder(item, 0))}{tree.files.map((file) => row(file, 0))}</>}
      </ul>
    </div>
  );
}

function ChangeRow({ change, depth, active, seen, onOpenDiff, onOpenFile }: {
  change: ChangedFile;
  /** null in the flat list, which shows each file's folder after its name. */
  depth: number | null;
  active: boolean;
  seen: boolean;
  onOpenDiff: (path: string) => void;
  onOpenFile: (path: string) => void;
}) {
  const meta = STATUS_META[change.status];
  const { dir, name } = splitPath(change.path);
  return (
    <li className={`group relative flex items-center ${active ? "bg-vs-active" : "hover:bg-vs-hover"}`}>
      {active && <span aria-hidden className="absolute inset-y-0 left-0 w-0.5 bg-vs-accent" />}
      <button
        type="button"
        onClick={() => onOpenDiff(change.path)}
        title={`${meta.label}: ${change.path}`}
        aria-label={`${meta.label}: ${change.path}`}
        style={{ paddingLeft: depth === null ? 12 : depth * 12 + 26 }}
        className={`flex h-7 min-w-0 flex-1 items-center gap-2 pr-2 text-left text-[12.5px] ${seen ? "opacity-55" : ""}`}
      >
        <FileTypeIcon name={change.path} />
        <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
          <span className={`shrink-0 truncate ${meta.name}`}>{name}</span>
          {depth === null && dir && <span className="min-w-0 truncate text-[11px] text-vs-muted" dir="rtl"><bdi dir="ltr">{dir}</bdi></span>}
        </span>
        {seen ? <CheckIcon className="h-3.5 w-3.5 shrink-0 text-vs-success" aria-label="Viewed" /> : <ChangeCounts added={change.added} removed={change.removed} binary={change.binary} compact />}
        <span className={`w-3 shrink-0 text-center font-mono text-[11px] font-bold ${meta.className}`} aria-hidden>{change.status}</span>
      </button>
      {change.status !== "D" && (
        <button type="button" onClick={() => onOpenFile(change.path)} aria-label={`Open ${change.path} in the editor`} title="Open file"
          className="absolute right-7 rounded bg-vs-hover p-1 text-vs-muted opacity-0 shadow-sm hover:text-vs-fg focus:opacity-100 group-hover:opacity-100">
          <OpenGlyph />
        </button>
      )}
    </li>
  );
}

const glyph = "h-3.5 w-3.5";
function ListGlyph() {
  return <svg viewBox="0 0 16 16" aria-hidden className={glyph} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M5.5 4h8M5.5 8h8M5.5 12h8" /><circle cx="2.5" cy="4" r=".6" fill="currentColor" /><circle cx="2.5" cy="8" r=".6" fill="currentColor" /><circle cx="2.5" cy="12" r=".6" fill="currentColor" /></svg>;
}
function TreeGlyph() {
  return <svg viewBox="0 0 16 16" aria-hidden className={glyph} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M2.5 2.5h4M4 2.5v9.5h3.5M4 7.25h3.5" /><path d="M9.5 7.25h4M9.5 12h4" /></svg>;
}
function OpenGlyph() {
  return <svg viewBox="0 0 16 16" aria-hidden className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M12 9.5v3.25a.75.75 0 0 1-.75.75h-8a.75.75 0 0 1-.75-.75v-8a.75.75 0 0 1 .75-.75H6.5" /></svg>;
}
