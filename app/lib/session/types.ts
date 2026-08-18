import type { TreeNode } from "../types";

/**
 * Git state for a session. This *is* the session's persistent state — restoring
 * one means `clone + checkout headSha`, nothing more. If a file blob ever ends
 * up in here, the design has drifted back to snapshotting.
 */
export type SessionRepo = {
  /** Name of the folder that was seeded, for the explorer header. */
  rootName: string;
  /** Branch the session forked from. */
  baseBranch: string;
  /** Where the base branch stood at fork time, so drift is cheap to compute. */
  baseShaAtFork: string;
  sessionBranch: string;
  headSha: string;
  /** Decides whether a resumed sandbox can skip dependency install. */
  depLockfileHash: string | null;
  /** Blob sha of AGENTS.md / CLAUDE.md at HEAD, null when absent. */
  specDocSha: string | null;
  containerImageDigest: string | null;
  lastTestStatus: "pass" | "fail" | "unknown";
  lastTestSha: string | null;
  seededAt: number;
};

/** Session as the client is allowed to see it. */
export type Session = {
  id: string;
  name: string;
  /** Shareable code a new device must present to join. */
  joinCode: string;
  createdAt: number;
  /** Null until the creator has seeded a folder into it. */
  repo: SessionRepo | null;
  /** Last time anyone read or wrote the repo. Drives retention. */
  lastActiveAt: number;
  /** Promoted to "keep": exempt from archiving and deletion. */
  pinned: boolean;
  /** Set when the working copy was reclaimed; the repo itself is untouched. */
  archivedAt: number | null;
};

export type SessionListResponse = { sessions: Session[] };

export type CreateSessionRequest = { name?: string };

export type JoinSessionRequest = { code: string };

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

export type SeedFile = {
  /** Repo-relative path. */
  path: string;
  /** Base64 contents — base64 so binaries survive the trip. */
  data: string;
};

export type SeedRequest = {
  files: SeedFile[];
  /** Set on the final batch: commits the tree and opens the session branch. */
  done?: boolean;
  /** Sent with the final batch. */
  rootName?: string;
  /** Upstream discovered in the uploaded `.git/config`, when there was one. */
  upstreamUrl?: string | null;
};

export type SeedResponse = {
  written: number;
  /** Paths rejected for size or an unsafe name. */
  skipped: string[];
  /** Present once `done` was acknowledged. */
  repo: SessionRepo | null;
};

// ---------------------------------------------------------------------------
// Tree and files
// ---------------------------------------------------------------------------

export type TreeResponse = {
  rootName: string;
  root: TreeNode;
  headSha: string;
  sessionBranch: string;
  files: number;
  bytes: number;
};

export type FileResponse = {
  path: string;
  text: string;
  size: number;
  truncated: boolean;
  binary: boolean;
};

export type SaveFileRequest = { path: string; text: string };

export type SaveFileResponse = {
  /** New HEAD, or the unchanged one when the write was a no-op. */
  headSha: string;
  committed: boolean;
};
