export type TreeNode = {
  name: string;
  /** Path relative to the picked folder. Empty string for the root node. */
  path: string;
  type: "file" | "dir";
  /** Bytes, files only. */
  size?: number;
  children?: TreeNode[];
  /** Directory that exists but was deliberately not traversed. */
  skipped?: boolean;
};

export type GitRemote = { name: string; url: string };

export type GitActivity = {
  message: string;
  author: string;
  /** Unix seconds. */
  timestamp: number;
};

export type GitInfo = {
  isGit: boolean;
  /** Current branch, or null when detached / unreadable. */
  branch: string | null;
  detached: boolean;
  /** Raw `.git/HEAD` contents. */
  head: string | null;
  /** Commit sha HEAD points at. */
  commit: string | null;
  branches: string[];
  remotes: GitRemote[];
  /** Last entry of `.git/logs/HEAD`. */
  lastActivity: GitActivity | null;
  /** Explains a partial read (linked worktree, unreadable .git, …). */
  note?: string;
};

export type ScanStats = {
  files: number;
  dirs: number;
  bytes: number;
  skippedDirs: number;
  /** Scan hit the entry cap and stopped early. */
  truncated: boolean;
  topTypes: { ext: string; count: number }[];
};

export type ScanSource = "picker" | "drop" | "input";

export type FileContent = {
  text: string;
  /** Full size on disk, even when `text` was truncated. */
  size: number;
  truncated: boolean;
  binary: boolean;
};

/** Reads one file by its path relative to the scanned root. */
export type ReadFile = (path: string) => Promise<FileContent | null>;

/** Raw bytes of one file, for uploads that must preserve binaries verbatim. */
export type ReadBytes = (path: string) => Promise<Uint8Array | null>;

export type ScanResult = {
  rootName: string;
  root: TreeNode;
  git: GitInfo;
  stats: ScanStats;
  source: ScanSource;
  /** True when hidden entries such as `.git` could not be seen at all. */
  hiddenFilesUnavailable: boolean;
  readFile: ReadFile;
  readBytes: ReadBytes;
};

export type ScanOptions = {
  includeIgnored?: boolean;
  onProgress?: (entries: number) => void;
};

/**
 * Minimal filesystem view that `readGitInfo` needs. Both the File System
 * Access API and a flat `File[]` can satisfy it.
 */
export type GitReader = {
  /** Returns null when the path is missing or unreadable. */
  readText(path: string): Promise<string | null>;
  /** Recursive file paths under `dir`, relative to `dir`. Null if missing. */
  listFiles(dir: string): Promise<string[] | null>;
};
