import { readGitInfo } from "./git";
import { compareNodes, sortTree } from "./tree";
import type {
  FileContent,
  GitReader,
  ScanOptions,
  ScanResult,
  ScanStats,
  TreeNode,
} from "./types";

/** Directories skipped unless the user asks for them. */
export const IGNORED_DIRS = new Set([
  ".cache",
  ".gradle",
  ".idea",
  ".next",
  ".nuxt",
  ".parcel-cache",
  ".pytest_cache",
  ".svelte-kit",
  ".turbo",
  ".venv",
  ".vscode",
  ".yarn",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "venv",
  "vendor",
]);

/** Never walked: we read the handful of files we need from it directly. */
const ALWAYS_SKIPPED = new Set([".git"]);

const MAX_ENTRIES = 20_000;
const MAX_DEPTH = 24;
/** Above this, only the head of a file is loaded into the editor. */
const MAX_TEXT_BYTES = 2 * 1024 * 1024;

type WalkState = {
  entries: number;
  truncated: boolean;
  includeIgnored: boolean;
  onProgress?: (entries: number) => void;
};

function shouldSkip(name: string, state: WalkState): boolean {
  if (ALWAYS_SKIPPED.has(name)) return true;
  return !state.includeIgnored && IGNORED_DIRS.has(name);
}

function tick(state: WalkState): boolean {
  if (state.entries >= MAX_ENTRIES) {
    state.truncated = true;
    return false;
  }
  state.entries += 1;
  if (state.entries % 250 === 0) state.onProgress?.(state.entries);
  return true;
}

// ---------------------------------------------------------------------------
// File System Access API (Chromium): lazy, and can read hidden files.
// ---------------------------------------------------------------------------

export async function scanDirectoryHandle(
  handle: FileSystemDirectoryHandle,
  source: "picker" | "drop",
  options: ScanOptions = {},
): Promise<ScanResult> {
  const state: WalkState = {
    entries: 0,
    truncated: false,
    includeIgnored: options.includeIgnored ?? false,
    onProgress: options.onProgress,
  };

  const root = await walkHandle(handle, "", 0, state);
  const git = await readGitInfo(handleReader(handle));

  return {
    rootName: handle.name || "folder",
    root,
    git,
    stats: collectStats(root, state.truncated),
    source,
    hiddenFilesUnavailable: false,
    readFile: async (path) => {
      const file = await fileAt(handle, path);
      if (!file) return null;
      try {
        return await readFileContent(file);
      } catch {
        return null;
      }
    },
    readBytes: async (path) => {
      const file = await fileAt(handle, path);
      if (!file) return null;
      try {
        return new Uint8Array(await file.arrayBuffer());
      } catch {
        return null;
      }
    },
  };
}

async function fileAt(root: FileSystemDirectoryHandle, path: string): Promise<File | null> {
  try {
    const segments = path.split("/").filter(Boolean);
    const fileName = segments.pop();
    if (!fileName) return null;
    let dir = root;
    for (const segment of segments) dir = await dir.getDirectoryHandle(segment);
    return await (await dir.getFileHandle(fileName)).getFile();
  } catch {
    return null;
  }
}

async function walkHandle(
  dir: FileSystemDirectoryHandle,
  path: string,
  depth: number,
  state: WalkState,
): Promise<TreeNode> {
  const node: TreeNode = {
    name: dir.name,
    path,
    type: "dir",
    children: [],
  };

  if (depth >= MAX_DEPTH) {
    node.skipped = true;
    return node;
  }

  for await (const entry of dir.values()) {
    if (!tick(state)) break;
    const childPath = path ? `${path}/${entry.name}` : entry.name;

    if (entry.kind === "directory") {
      const child = entry as FileSystemDirectoryHandle;
      if (shouldSkip(entry.name, state)) {
        node.children!.push({
          name: entry.name,
          path: childPath,
          type: "dir",
          skipped: true,
          children: [],
        });
        continue;
      }
      node.children!.push(await walkHandle(child, childPath, depth + 1, state));
    } else {
      let size = 0;
      try {
        size = (await (entry as FileSystemFileHandle).getFile()).size;
      } catch {
        // Unreadable file (permissions, vanished mid-scan): keep it listed.
      }
      node.children!.push({ name: entry.name, path: childPath, type: "file", size });
    }
  }

  sortChildren(node);
  return node;
}

function handleReader(root: FileSystemDirectoryHandle): GitReader {
  async function resolveDir(path: string) {
    let dir = root;
    for (const segment of path.split("/").filter(Boolean)) {
      dir = await dir.getDirectoryHandle(segment);
    }
    return dir;
  }

  return {
    async readText(path) {
      try {
        const segments = path.split("/").filter(Boolean);
        const fileName = segments.pop();
        if (!fileName) return null;
        const dir = await resolveDir(segments.join("/"));
        const file = await (await dir.getFileHandle(fileName)).getFile();
        return await file.text();
      } catch {
        return null;
      }
    },
    async listFiles(path) {
      try {
        const dir = await resolveDir(path);
        const out: string[] = [];
        await collectHandleFiles(dir, "", out, 0);
        return out;
      } catch {
        return null;
      }
    },
  };
}

async function collectHandleFiles(
  dir: FileSystemDirectoryHandle,
  prefix: string,
  out: string[],
  depth: number,
): Promise<void> {
  if (depth > 8 || out.length > 5_000) return;
  for await (const entry of dir.values()) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.kind === "directory") {
      await collectHandleFiles(entry as FileSystemDirectoryHandle, path, out, depth + 1);
    } else {
      out.push(path);
    }
  }
}

// ---------------------------------------------------------------------------
// Flat File[] (folder <input>, or drag-and-drop without handle support).
// ---------------------------------------------------------------------------

export async function scanFileList(
  files: File[],
  source: "input" | "drop",
  options: ScanOptions = {},
): Promise<ScanResult> {
  const state: WalkState = {
    entries: 0,
    truncated: false,
    includeIgnored: options.includeIgnored ?? false,
    onProgress: options.onProgress,
  };

  // `webkitRelativePath` is `<rootFolder>/<…>`; strip the root segment so paths
  // are relative to the folder the user picked.
  const byPath = new Map<string, File>();
  let rootName = "folder";
  for (const file of files) {
    const full = relativePathOf(file);
    const slashAt = full.indexOf("/");
    if (slashAt < 0) {
      byPath.set(full, file);
      continue;
    }
    rootName = full.slice(0, slashAt);
    byPath.set(full.slice(slashAt + 1), file);
  }

  const root = buildTreeFromPaths(rootName, byPath, state);
  const git = await readGitInfo(mapReader(byPath));

  return {
    rootName,
    root,
    git,
    stats: collectStats(root, state.truncated),
    source,
    // Browsers that strip dotfiles from folder uploads make Git undetectable.
    hiddenFilesUnavailable: ![...byPath.keys()].some((p) =>
      p.split("/").some((s) => s.startsWith(".")),
    ),
    readFile: async (path) => {
      const file = byPath.get(path);
      if (!file) return null;
      try {
        return await readFileContent(file);
      } catch {
        return null;
      }
    },
    readBytes: async (path) => {
      const file = byPath.get(path);
      if (!file) return null;
      try {
        return new Uint8Array(await file.arrayBuffer());
      } catch {
        return null;
      }
    },
  };
}

/** Loads a file as text, refusing binaries and capping very large files. */
async function readFileContent(file: File): Promise<FileContent> {
  const head = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
  // A NUL byte in the first block is the usual "this is not text" signal.
  if (head.includes(0)) {
    return { text: "", size: file.size, truncated: false, binary: true };
  }

  const truncated = file.size > MAX_TEXT_BYTES;
  const blob = truncated ? file.slice(0, MAX_TEXT_BYTES) : file;
  return { text: await blob.text(), size: file.size, truncated, binary: false };
}

function relativePathOf(file: File): string {
  return file.webkitRelativePath || file.name;
}

function buildTreeFromPaths(
  rootName: string,
  byPath: Map<string, File>,
  state: WalkState,
): TreeNode {
  const root: TreeNode = { name: rootName, path: "", type: "dir", children: [] };
  const dirs = new Map<string, TreeNode>([["", root]]);

  const paths = [...byPath.keys()].sort((a, b) => a.localeCompare(b));

  outer: for (const path of paths) {
    const segments = path.split("/");
    let parent = root;
    let parentPath = "";
    let blocked = false;

    for (const name of segments.slice(0, -1)) {
      const childPath = parentPath ? `${parentPath}/${name}` : name;
      let dir = dirs.get(childPath);

      if (!dir) {
        if (!tick(state)) break outer;
        dir = {
          name,
          path: childPath,
          type: "dir",
          children: [],
          ...(shouldSkip(name, state) ? { skipped: true } : {}),
        };
        dirs.set(childPath, dir);
        parent.children!.push(dir);
      }

      if (dir.skipped) {
        blocked = true;
        break;
      }
      parent = dir;
      parentPath = childPath;
    }

    if (blocked) continue;
    if (!tick(state)) break outer;

    const name = segments[segments.length - 1];
    parent.children!.push({
      name,
      path,
      type: "file",
      size: byPath.get(path)?.size ?? 0,
    });
  }

  sortTree(root);
  return root;
}

function mapReader(byPath: Map<string, File>): GitReader {
  return {
    async readText(path) {
      const file = byPath.get(path);
      if (!file) return null;
      try {
        return await file.text();
      } catch {
        return null;
      }
    },
    async listFiles(dir) {
      const prefix = `${dir}/`;
      const out: string[] = [];
      for (const path of byPath.keys()) {
        if (path.startsWith(prefix)) out.push(path.slice(prefix.length));
      }
      // Distinguish "no such directory" from "directory is empty".
      if (out.length === 0 && !byPath.has(dir)) return null;
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// Drag and drop
// ---------------------------------------------------------------------------

export type DroppedFolder =
  | { kind: "handle"; handle: FileSystemDirectoryHandle }
  | { kind: "files"; files: File[] };

/**
 * Turns a drop into something scannable. Prefers a directory handle (hidden
 * files readable), otherwise walks the legacy entry API.
 */
export async function readDroppedFolder(
  dataTransfer: DataTransfer,
): Promise<DroppedFolder | null> {
  // The drag data store is only readable during the drop event, so take
  // everything we might need before the first `await`.
  const items = [...dataTransfer.items].filter((item) => item.kind === "file");
  const handles = items.map((item) =>
    item.getAsFileSystemHandle
      ? item.getAsFileSystemHandle().catch(() => null)
      : Promise.resolve(null),
  );
  const entries = items
    .map((item) => item.webkitGetAsEntry())
    .filter((entry): entry is FileSystemEntry => entry !== null);

  for (const handle of await Promise.all(handles)) {
    if (handle?.kind === "directory") {
      return { kind: "handle", handle: handle as FileSystemDirectoryHandle };
    }
  }

  const directory = entries.find((entry) => entry.isDirectory);
  if (!directory) return null;

  const files: File[] = [];
  await collectEntryFiles(directory as FileSystemDirectoryEntry, directory.name, files);
  return { kind: "files", files };
}

async function collectEntryFiles(
  dir: FileSystemDirectoryEntry,
  prefix: string,
  out: File[],
): Promise<void> {
  if (out.length > MAX_ENTRIES) return;

  const reader = dir.createReader();
  // readEntries yields at most ~100 entries per call and signals the end with
  // an empty batch.
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
      reader.readEntries(resolve, reject),
    );
    if (batch.length === 0) break;

    for (const entry of batch) {
      const path = `${prefix}/${entry.name}`;
      if (entry.isDirectory) {
        await collectEntryFiles(entry as FileSystemDirectoryEntry, path, out);
      } else {
        const file = await new Promise<File>((resolve, reject) =>
          (entry as FileSystemFileEntry).file(resolve, reject),
        );
        // `webkitRelativePath` is read-only on File, so carry the path along.
        Object.defineProperty(file, "webkitRelativePath", {
          value: path,
          configurable: true,
        });
        out.push(file);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function sortChildren(node: TreeNode): void {
  node.children?.sort(compareNodes);
}

export function collectStats(root: TreeNode, truncated: boolean): ScanStats {
  let files = 0;
  let dirs = 0;
  let bytes = 0;
  let skippedDirs = 0;
  const extensions = new Map<string, number>();

  const stack: TreeNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === "file") {
      files += 1;
      bytes += node.size ?? 0;
      const ext = extensionOf(node.name);
      if (ext) extensions.set(ext, (extensions.get(ext) ?? 0) + 1);
      continue;
    }
    if (node !== root) dirs += 1;
    if (node.skipped) skippedDirs += 1;
    for (const child of node.children ?? []) stack.push(child);
  }

  const topTypes = [...extensions.entries()]
    .map(([ext, count]) => ({ ext, count }))
    .sort((a, b) => b.count - a.count || a.ext.localeCompare(b.ext))
    .slice(0, 6);

  return { files, dirs, bytes, skippedDirs, truncated, topTypes };
}

function extensionOf(name: string): string | null {
  const dotAt = name.lastIndexOf(".");
  if (dotAt <= 0 || dotAt === name.length - 1) return null;
  return name.slice(dotAt + 1).toLowerCase();
}
