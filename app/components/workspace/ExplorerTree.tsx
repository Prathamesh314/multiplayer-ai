"use client";

import { useMemo } from "react";
import { humanBytes } from "../../lib/format";
import type { ChangedFile } from "../../lib/session/types";
import type { TreeNode } from "../../lib/types";
import { ChevronIcon, FolderIcon } from "../icons";
import { STATUS_META } from "./ChangesList";
import { FileTypeIcon } from "./FileTypeIcon";
import { EditingBadge } from "./People";
import type { FilePresence } from "./usePeople";

type ExplorerTreeProps = {
  root: TreeNode;
  activePath: string | null;
  query: string;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onOpenFile: (path: string) => void;
  /** Repo path → who is typing in it right now. */
  editing: Map<string, FilePresence[]>;
  /** Repo path → its change since import, shown the way VS Code decorates Git status. */
  changes?: Map<string, ChangedFile>;
};

export function ExplorerTree({
  root,
  activePath,
  query,
  expanded,
  onToggle,
  onOpenFile,
  editing,
  changes,
}: ExplorerTreeProps) {
  const trimmed = query.trim().toLowerCase();
  const visible = useMemo(
    () => (trimmed ? (filterTree(root, trimmed) ?? { ...root, children: [] }) : root),
    [root, trimmed],
  );

  const rows = flatten(visible, expanded, trimmed.length > 0);
  // Folders holding a changed file get a dot, so a collapsed tree still shows where work happened.
  const changedDirs = useMemo(() => {
    const dirs = new Set<string>();
    for (const path of changes?.keys() ?? []) {
      const parts = path.split("/");
      for (let index = 1; index < parts.length; index++) dirs.add(parts.slice(0, index).join("/"));
    }
    return dirs;
  }, [changes]);

  return (
    <div className="py-1 text-[14px] leading-[24px]">
      {rows.map((row) => (
        <Row
          key={row.node.path}
          node={row.node}
          depth={row.depth}
          open={row.open}
          active={row.node.path === activePath}
          editing={editing.get(row.node.path) ?? []}
          change={row.node.type === "dir" ? undefined : changes?.get(row.node.path)}
          holdsChanges={row.node.type === "dir" && changedDirs.has(row.node.path)}
          onActivate={() =>
            row.node.type === "dir" ? onToggle(row.node.path) : onOpenFile(row.node.path)
          }
        />
      ))}
      {trimmed && rows.length === 0 && (
        <p className="px-4 py-3 text-sm text-vs-muted">No match for “{query.trim()}”.</p>
      )}
    </div>
  );
}

type RowProps = {
  node: TreeNode;
  depth: number;
  open: boolean;
  active: boolean;
  editing: FilePresence[];
  change?: ChangedFile;
  holdsChanges: boolean;
  onActivate: () => void;
};

function Row({ node, depth, open, active, editing, change, holdsChanges, onActivate }: RowProps) {
  const isDir = node.type === "dir";
  const meta = change ? STATUS_META[change.status] : null;

  return (
    <button
      type="button"
      onClick={onActivate}
      title={node.path || node.name}
      aria-label={`${isDir ? "Folder" : "File"}: ${node.path || node.name}`}
      aria-expanded={isDir ? open : undefined}
      aria-current={active ? "true" : undefined}
      disabled={!!node.skipped}
      style={{ paddingLeft: `${depth * 12 + 8}px` }}
      className={`group relative flex h-7 w-full items-center gap-1.5 pr-2 text-left text-[13px] ${
        active ? "bg-vs-active text-vs-fg" : "hover:bg-vs-hover"
      } ${node.skipped ? "opacity-55" : ""}`}
    >
      {active && <span aria-hidden className="absolute inset-y-0 left-0 w-0.5 bg-vs-accent" />}
      {/* Indent guides, one per level, like an editor's tree. */}
      {Array.from({ length: depth }, (_, level) => (
        <span key={level} aria-hidden className="absolute inset-y-0 w-px bg-vs-border/70" style={{ left: `${level * 12 + 15}px` }} />
      ))}
      <span className="flex h-4 w-4 shrink-0 items-center justify-center">
        {isDir && !node.skipped && (
          <ChevronIcon
            className={`h-3.5 w-3.5 text-vs-muted transition-transform ${open ? "rotate-90" : ""}`}
          />
        )}
      </span>
      {isDir ? (
        <FolderIcon open={open} className="h-4 w-4 shrink-0 text-sky-500 dark:text-sky-400" />
      ) : (
        <FileTypeIcon name={node.name} />
      )}
      <span className={`truncate ${meta ? meta.name : holdsChanges ? "text-vs-warn/90" : ""}`}>{node.name}</span>
      {node.skipped && (
        <span className="ml-auto shrink-0 text-[11px] uppercase tracking-wide text-vs-muted">
          not scanned
        </span>
      )}
      {isDir && holdsChanges && !open && <span aria-label="Contains changes" className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-vs-warn/80" />}
      {!isDir && editing.length > 0 ? (
        <EditingBadge people={editing} compact />
      ) : (
        !isDir && (
          <span className="ml-auto flex shrink-0 items-center gap-2 pl-2">
            <span className="text-[11px] tabular-nums text-vs-muted opacity-0 transition-opacity group-hover:opacity-100">{humanBytes(node.size ?? 0)}</span>
            {meta && change && <span className={`w-3 text-center font-mono text-[11px] font-bold ${meta.className}`} title={meta.label}>{change.status}</span>}
          </span>
        )
      )}
    </button>
  );
}

type FlatRow = { node: TreeNode; depth: number; open: boolean };

/**
 * Flattens the visible part of the tree into rows. Only expanded branches are
 * walked, so a huge folder costs nothing until it is opened.
 */
function flatten(root: TreeNode, expanded: Set<string>, forceExpand: boolean): FlatRow[] {
  const rows: FlatRow[] = [];

  function visit(node: TreeNode, depth: number) {
    if (node.type === "file") {
      rows.push({ node, depth, open: false });
      return;
    }
    const open = !node.skipped && (forceExpand || expanded.has(node.path));
    rows.push({ node, depth, open });
    if (!open) return;
    for (const child of node.children ?? []) visit(child, depth + 1);
  }

  // The root itself is rendered by the panel header, so start with its children.
  for (const child of root.children ?? []) visit(child, 0);
  return rows;
}

export function defaultExpanded(root: TreeNode): Set<string> {
  const paths = new Set<string>([""]);
  for (const child of root.children ?? []) {
    if (child.type === "dir" && !child.skipped) paths.add(child.path);
  }
  return paths;
}

export function allDirPaths(root: TreeNode): Set<string> {
  const paths = new Set<string>();
  const stack: TreeNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type !== "dir") continue;
    paths.add(node.path);
    for (const child of node.children ?? []) stack.push(child);
  }
  return paths;
}

/** Keeps a node when it matches, or when any descendant does. */
function filterTree(node: TreeNode, query: string): TreeNode | null {
  if (node.type === "file") {
    return node.path.toLowerCase().includes(query) ? node : null;
  }

  if (node.path.toLowerCase().includes(query)) return node;
  const children = (node.children ?? [])
    .map((child) => filterTree(child, query))
    .filter((child): child is TreeNode => child !== null);

  if (children.length > 0) return { ...node, children };
  return node.name.toLowerCase().includes(query) ? { ...node, children: [] } : null;
}
