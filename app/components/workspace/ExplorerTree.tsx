"use client";

import { useMemo } from "react";
import { humanBytes } from "../../lib/format";
import type { TreeNode } from "../../lib/types";
import { ChevronIcon, FileIcon, FolderIcon } from "../icons";

type ExplorerTreeProps = {
  root: TreeNode;
  activePath: string | null;
  query: string;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onOpenFile: (path: string) => void;
};

export function ExplorerTree({
  root,
  activePath,
  query,
  expanded,
  onToggle,
  onOpenFile,
}: ExplorerTreeProps) {
  const trimmed = query.trim().toLowerCase();
  const visible = useMemo(
    () => (trimmed ? (filterTree(root, trimmed) ?? { ...root, children: [] }) : root),
    [root, trimmed],
  );

  const rows = flatten(visible, expanded, trimmed.length > 0);

  return (
    <div className="py-1 text-[13px] leading-[22px]">
      {rows.map((row) => (
        <Row
          key={row.node.path}
          node={row.node}
          depth={row.depth}
          open={row.open}
          active={row.node.path === activePath}
          onActivate={() =>
            row.node.type === "dir" ? onToggle(row.node.path) : onOpenFile(row.node.path)
          }
        />
      ))}
      {trimmed && rows.length === 0 && (
        <p className="px-4 py-3 text-xs text-vs-muted">No match for “{query.trim()}”.</p>
      )}
    </div>
  );
}

type RowProps = {
  node: TreeNode;
  depth: number;
  open: boolean;
  active: boolean;
  onActivate: () => void;
};

function Row({ node, depth, open, active, onActivate }: RowProps) {
  const isDir = node.type === "dir";

  return (
    <button
      type="button"
      onClick={onActivate}
      title={node.path || node.name}
      style={{ paddingLeft: `${depth * 12 + 8}px` }}
      className={`group flex w-full items-center gap-1.5 pr-2 text-left ${
        active ? "bg-vs-active text-vs-fg" : "hover:bg-vs-hover"
      } ${node.skipped ? "opacity-55" : ""}`}
    >
      <span className="flex h-4 w-4 items-center justify-center">
        {isDir && !node.skipped && (
          <ChevronIcon
            className={`h-3.5 w-3.5 text-vs-muted transition-transform ${open ? "rotate-90" : ""}`}
          />
        )}
      </span>
      {isDir ? (
        <FolderIcon open={open} className="h-4 w-4 text-sky-500 dark:text-sky-400" />
      ) : (
        <FileIcon className={`h-4 w-4 ${extensionColor(node.name)}`} />
      )}
      <span className="truncate">{node.name}</span>
      {node.skipped && (
        <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wide text-vs-muted">
          not scanned
        </span>
      )}
      {!isDir && (
        <span className="ml-auto shrink-0 pl-2 text-[10px] tabular-nums text-vs-muted opacity-0 transition-opacity group-hover:opacity-100">
          {humanBytes(node.size ?? 0)}
        </span>
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
    return node.name.toLowerCase().includes(query) ? node : null;
  }

  const children = (node.children ?? [])
    .map((child) => filterTree(child, query))
    .filter((child): child is TreeNode => child !== null);

  if (children.length > 0) return { ...node, children };
  return node.name.toLowerCase().includes(query) ? { ...node, children: [] } : null;
}

const EXTENSION_COLORS: Record<string, string> = {
  ts: "text-blue-500 dark:text-blue-400",
  tsx: "text-blue-500 dark:text-blue-400",
  mts: "text-blue-500 dark:text-blue-400",
  js: "text-amber-500 dark:text-amber-400",
  jsx: "text-amber-500 dark:text-amber-400",
  mjs: "text-amber-500 dark:text-amber-400",
  cjs: "text-amber-500 dark:text-amber-400",
  json: "text-amber-600 dark:text-amber-300",
  css: "text-violet-500 dark:text-violet-400",
  scss: "text-violet-500 dark:text-violet-400",
  html: "text-orange-500 dark:text-orange-400",
  md: "text-slate-500 dark:text-slate-300",
  mdx: "text-slate-500 dark:text-slate-300",
  py: "text-emerald-500 dark:text-emerald-400",
  go: "text-cyan-500 dark:text-cyan-400",
  rs: "text-orange-600 dark:text-orange-300",
  java: "text-red-500 dark:text-red-400",
  rb: "text-rose-500 dark:text-rose-400",
  sh: "text-lime-600 dark:text-lime-400",
  yml: "text-teal-500 dark:text-teal-400",
  yaml: "text-teal-500 dark:text-teal-400",
  svg: "text-fuchsia-500 dark:text-fuchsia-400",
  png: "text-fuchsia-500 dark:text-fuchsia-400",
  jpg: "text-fuchsia-500 dark:text-fuchsia-400",
  jpeg: "text-fuchsia-500 dark:text-fuchsia-400",
  gif: "text-fuchsia-500 dark:text-fuchsia-400",
  ico: "text-fuchsia-500 dark:text-fuchsia-400",
};

function extensionColor(name: string): string {
  const dotAt = name.lastIndexOf(".");
  const ext = dotAt > 0 ? name.slice(dotAt + 1).toLowerCase() : "";
  return EXTENSION_COLORS[ext] ?? "text-vs-muted";
}
