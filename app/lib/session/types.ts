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

export type SessionRole = "owner" | "editor" | "viewer";

/** What a share link may grant. Never "owner". */
export type ShareRole = Exclude<SessionRole, "owner">;

/** Highest wins when someone redeems a second link. */
const RANK: Record<SessionRole, number> = { viewer: 1, editor: 2, owner: 3 };

export const outranks = (a: SessionRole, b: SessionRole) => RANK[a] > RANK[b];

export const canEdit = (role: SessionRole | null | undefined) =>
  role === "owner" || role === "editor";

/** A share link as the owner sees it. The token is not included: it is shown
 *  once at creation and only its hash is stored. */
export type ShareLink = {
  id: string;
  role: ShareRole;
  label: string | null;
  createdAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
  uses: number;
};

export type ShareLinksResponse = { links: ShareLink[] };

export type CreateShareLinkRequest = { role: ShareRole; label?: string; expiresInDays?: number };

/** The one response that carries a token, because it is the only chance to. */
export type CreateShareLinkResponse = { link: ShareLink; token: string };

/** Session as the client is allowed to see it. */
export type Session = {
  id: string;
  name: string;
  /** Shareable code a new device must present to join. */
  joinCode: string;
  /** The account that created it. Sessions are never ownerless. */
  ownerId: string;
  /** Null for a personal session that belongs to no org. */
  orgId: string | null;
  createdAt: number;
  /** Null until the creator has seeded a folder into it. */
  repo: SessionRepo | null;
  /** Last time anyone read or wrote the repo. Drives retention. */
  lastActiveAt: number;
  /** Promoted to "keep": exempt from archiving and deletion. */
  pinned: boolean;
  /** Set when the working copy was reclaimed; the repo itself is untouched. */
  archivedAt: number | null;
  /** The requesting account's role. Null in contexts with no caller. */
  myRole: SessionRole | null;
};

/** A person on a session's roster, with live presence folded in. */
export type SessionMember = {
  userId: string;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  role: SessionRole;
  /** Durable "last opened", distinct from presence. */
  lastSeenAt: number | null;
  /** From Redis, not the database. */
  online: boolean;
  /** True for the account making the request, so the UI can label it "Me". */
  isSelf?: boolean;
};

export type MembersResponse = { members: SessionMember[] };

/** One chat message, with its author resolved. */
export type ChatMessage = {
  id: string;
  userId: string;
  userName: string;
  handle: string;
  body: string;
  createdAt: number;
};

export type MessagesResponse = {
  /** Oldest first, ready to render. */
  messages: ChatMessage[];
  /** True when older messages exist before the first one returned. */
  hasMore: boolean;
};

export type SendMessageRequest = { body: string };

export type SessionListResponse = { sessions: Session[] };

export type CreateSessionRequest = { name?: string };

/** Exactly one of these. A token carries a role; a code always means viewer. */
export type JoinSessionRequest = { code?: string; token?: string };

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

/** A file that differs from the session's seed commit. Status is git's letter. */
export type ChangedFile = {
  path: string;
  /** "A" added, "M" modified, "D" deleted, "R" renamed, "C" copied. */
  status: "A" | "M" | "D" | "R" | "C";
};

export type ChangesResponse = { changes: ChangedFile[] };

export type SaveFileRequest = {
  path: string;
  text: string;
  /** The tab that saved, echoed back on the broadcast so it can ignore itself. */
  originId?: string;
};

export type SaveFileResponse = {
  /** New HEAD, or the unchanged one when the write was a no-op. */
  headSha: string;
  committed: boolean;
};
