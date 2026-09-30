import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { query, queryOne, transaction } from "../db/client";
import type {
  ChatMessage,
  Session,
  SessionMember,
  SessionRepo,
  SessionRole,
  ShareLink,
  ShareRole,
} from "./types";

/**
 * Sessions live in Postgres. The git repo on disk is still the record for file
 * contents — this table records who owns the session, who may open it, and
 * where its branch currently points.
 */

const ID_ALPHABET = "abcdefghijkmnopqrstuvwxyz23456789";
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

type SessionRow = {
  id: string;
  name: string;
  join_code: string;
  owner_id: string;
  org_id: string | null;
  project_id: string | null;
  visibility: "public" | "private";
  root_name: string | null;
  created_at: Date;
  last_active_at: Date;
  pinned: boolean;
  archived_at: Date | null;
  // Joined from session_repos; null before seeding.
  base_branch: string | null;
  base_sha_at_fork: string | null;
  session_branch: string | null;
  head_sha: string | null;
  dep_lockfile_hash: string | null;
  spec_doc_sha: string | null;
  container_image_digest: string | null;
  last_test_status: string | null;
  last_test_sha: string | null;
  repo_root_name: string | null;
  project_repository_id: string | null;
  seeded_at: Date | null;
};

const SELECT_SESSION = `
  SELECT s.id, s.name, s.join_code, s.owner_id, s.org_id, s.project_id, s.visibility,
         s.root_name, s.created_at, s.last_active_at, s.pinned, s.archived_at,
         r.base_branch, r.base_sha_at_fork, r.session_branch, r.head_sha,
         r.dep_lockfile_hash, r.spec_doc_sha, r.container_image_digest,
         r.project_repository_id, r.last_test_status, r.last_test_sha, r.root_name AS repo_root_name, r.seeded_at
    FROM sessions s
    LEFT JOIN session_repos r ON r.session_id = s.id
`;

function toSession(row: SessionRow, myRole?: SessionRole | null): Session {
  const repo: SessionRepo | null = row.session_branch
    ? {
        projectRepositoryId: row.project_repository_id ?? null,
        rootName: row.repo_root_name ?? row.root_name ?? row.name,
        baseBranch: row.base_branch!,
        baseShaAtFork: row.base_sha_at_fork!,
        sessionBranch: row.session_branch,
        headSha: row.head_sha!,
        depLockfileHash: row.dep_lockfile_hash,
        specDocSha: row.spec_doc_sha,
        containerImageDigest: row.container_image_digest,
        lastTestStatus: (row.last_test_status ?? "unknown") as SessionRepo["lastTestStatus"],
        lastTestSha: row.last_test_sha,
        seededAt: row.seeded_at ? row.seeded_at.getTime() : 0,
      }
    : null;

  return {
    id: row.id,
    name: row.name,
    joinCode: row.join_code,
    ownerId: row.owner_id,
    orgId: row.org_id,
    projectId: row.project_id,
    visibility: row.visibility,
    createdAt: row.created_at.getTime(),
    lastActiveAt: row.last_active_at.getTime(),
    pinned: row.pinned,
    archivedAt: row.archived_at ? row.archived_at.getTime() : null,
    myRole: myRole ?? null,
    repo,
  };
}

// ---------------------------------------------------------------------------
// Share links
// ---------------------------------------------------------------------------

/**
 * The token is 32 random bytes, so an unsalted SHA-256 is the right store:
 * there is nothing to brute force, and the database never holds anything that
 * could be pasted into a URL.
 */
const tokenDigest = (token: string) => createHash("sha256").update(token, "utf8").digest();

type LinkRow = {
  id: string;
  role: ShareRole;
  label: string | null;
  created_at: Date;
  expires_at: Date | null;
  last_used_at: Date | null;
  uses: number;
};

const toLink = (row: LinkRow): ShareLink => ({
  id: row.id,
  role: row.role,
  label: row.label,
  createdAt: row.created_at.getTime(),
  expiresAt: row.expires_at ? row.expires_at.getTime() : null,
  lastUsedAt: row.last_used_at ? row.last_used_at.getTime() : null,
  uses: row.uses,
});

export async function createShareLink(
  sessionId: string,
  role: ShareRole,
  createdBy: string,
  options: { label?: string | null; expiresInDays?: number | null } = {},
): Promise<{ link: ShareLink; token: string }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt =
    options.expiresInDays && options.expiresInDays > 0
      ? new Date(Date.now() + options.expiresInDays * 24 * 60 * 60 * 1000)
      : null;

  const row = await queryOne<LinkRow>(
    `INSERT INTO session_share_links (session_id, token_hash, role, label, created_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, role, label, created_at, expires_at, last_used_at, uses`,
    [sessionId, tokenDigest(token), role, options.label ?? null, createdBy, expiresAt],
  );

  return { link: toLink(row!), token };
}

export async function listShareLinks(sessionId: string): Promise<ShareLink[]> {
  const rows = await query<LinkRow>(
    `SELECT id, role, label, created_at, expires_at, last_used_at, uses
       FROM session_share_links
      WHERE session_id = $1 AND revoked_at IS NULL
      ORDER BY created_at DESC`,
    [sessionId],
  );
  return rows.map(toLink);
}

export async function revokeShareLink(sessionId: string, linkId: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `UPDATE session_share_links SET revoked_at = now()
      WHERE id = $1 AND session_id = $2 AND revoked_at IS NULL
      RETURNING id`,
    [linkId, sessionId],
  );
  return rows.length > 0;
}

/**
 * Resolves a token to the role it grants, and records the use.
 *
 * Expiry and revocation are checked in the same statement that consumes it, so
 * there is no window between "is this valid" and "use it".
 */
export async function redeemShareLink(
  sessionId: string,
  token: string,
): Promise<ShareRole | null> {
  const row = await queryOne<{ role: ShareRole }>(
    `UPDATE session_share_links
        SET uses = uses + 1, last_used_at = now()
      WHERE session_id = $1
        AND token_hash = $2
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > now())
    RETURNING role`,
    [sessionId, tokenDigest(token)],
  );
  return row?.role ?? null;
}

/** A room can belong to an org project; omit both for a personal session. */
export type CreateSessionOptions = {
  orgId?: string | null;
  projectId?: string | null;
  /** 'private' makes the room invite-only; defaults to 'public'. */
  visibility?: "public" | "private";
  /** Pinned rooms are exempt from the retention sweep. */
  pinned?: boolean;
};

export async function createSession(
  ownerId: string,
  requestedName?: string,
  options: CreateSessionOptions = {},
): Promise<Session> {
  const name = cleanName(requestedName) ?? `Session ${randomString(4, CODE_ALPHABET)}`;
  const joinCode = `${randomString(4, CODE_ALPHABET)}-${randomString(4, CODE_ALPHABET)}`;
  const orgId = options.orgId ?? null;
  const projectId = options.projectId ?? null;
  const visibility = options.visibility === "private" ? "private" : "public";
  const pinned = options.pinned === true;

  // The session and its owner row must appear together: a session nobody can
  // open is not a state worth being able to reach. For an org project room the
  // authority is project_members, but the creator still gets an owner row so
  // they keep control of the room they made.
  return transaction(async (tx) => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const id = randomString(12, ID_ALPHABET);
      const inserted = await tx.query<SessionRow>(
        `INSERT INTO sessions (id, owner_id, org_id, project_id, visibility, name, join_code, pinned)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO NOTHING
         RETURNING id, name, join_code, owner_id, org_id, project_id, visibility, root_name,
                   created_at, last_active_at, pinned, archived_at,
                   NULL AS base_branch, NULL AS base_sha_at_fork, NULL AS session_branch,
                   NULL AS head_sha, NULL AS dep_lockfile_hash, NULL AS spec_doc_sha,
                   NULL AS container_image_digest, NULL AS last_test_status,
                   NULL AS last_test_sha, NULL AS repo_root_name, NULL AS seeded_at`,
        [id, ownerId, orgId, projectId, visibility, name, joinCode, pinned],
      );

      if (inserted.rows.length === 0) continue; // id collision, try another

      await tx.query(
        `INSERT INTO session_members (session_id, user_id, role, added_via)
         VALUES ($1, $2, 'owner', 'owner')`,
        [id, ownerId],
      );

      return toSession(inserted.rows[0]);
    }

    throw new Error("Could not allocate a session id.");
  });
}

/**
 * A member's own room in a project. The sessions_member_room_key index makes
 * this at most one row: a member has exactly one room per project.
 */
export async function memberRoomInProject(
  projectId: string,
  ownerId: string,
): Promise<Session | null> {
  const row = await queryOne<SessionRow>(
    `${SELECT_SESSION}
      WHERE s.project_id = $1 AND s.owner_id = $2 AND s.deleted_at IS NULL`,
    [projectId, ownerId],
  );
  return row ? toSession(row) : null;
}

/**
 * Rooms in a project the caller may see: every public room, plus the private
 * ones they are on the roster of. A private room is simply absent from the list
 * for everyone else — the point of it being private.
 */
export async function listRoomsInProject(projectId: string, viewerId: string): Promise<Session[]> {
  const rows = await query<SessionRow>(
    `${SELECT_SESSION}
      WHERE s.project_id = $1 AND s.deleted_at IS NULL
        AND (
          s.visibility = 'public'
          OR EXISTS (
            SELECT 1 FROM session_members m
             WHERE m.session_id = s.id AND m.user_id = $2 AND m.removed_at IS NULL
          )
        )
      ORDER BY s.last_active_at DESC`,
    [projectId, viewerId],
  );
  return rows.map((row) => toSession(row));
}

/** Flips a room between public and invite-only. */
export async function setVisibility(
  id: string,
  visibility: "public" | "private",
): Promise<Session | null> {
  await query(`UPDATE sessions SET visibility = $2 WHERE id = $1`, [id, visibility]);
  return getSession(id);
}

export async function getSession(id: string, viewerId?: string): Promise<Session | null> {
  const row = await queryOne<SessionRow & { my_role?: SessionRole | null }>(
    `${viewerId ? SELECT_SESSION.replace("SELECT ", "SELECT room_access_role(s.id,$2) AS my_role, ") : SELECT_SESSION}
      WHERE s.id = $1 AND s.deleted_at IS NULL`,
    viewerId ? [id, viewerId] : [id],
  );
  if (!row) return null;
  // The caller's own role travels with the session so the UI knows what to
  // enable without a second request. For an org project room it is derived from
  // the project roster; a personal room falls back to session_members.
  return toSession(row, row.my_role ?? null);
}

/** Sessions this user may open, most recently active first. */
export async function listSessionsForUser(userId: string): Promise<Session[]> {
  const rows = await query<SessionRow & { my_role: SessionRole }>(
    `${SELECT_SESSION.replace("SELECT ", "SELECT m.role AS my_role, ")}
      JOIN session_members m ON m.session_id = s.id
     WHERE m.user_id = $1 AND m.removed_at IS NULL AND s.deleted_at IS NULL
     ORDER BY s.last_active_at DESC`,
    [userId],
  );
  return rows.map((row) => toSession(row, row.my_role));
}

export async function renameSession(id: string, name: string): Promise<Session | null> {
  const cleaned = cleanName(name);
  if (!cleaned) return null;
  await query(`UPDATE sessions SET name = $2 WHERE id = $1`, [id, cleaned]);
  return getSession(id);
}

export async function setPinned(id: string, pinned: boolean): Promise<Session | null> {
  await query(`UPDATE sessions SET pinned = $2 WHERE id = $1`, [id, pinned]);
  return getSession(id);
}

/** Records the git state produced by a seed. */
export async function attachRepo(
  id: string,
  repo: SessionRepo,
  upstreamUrl: string | null,
): Promise<Session | null> {
  await transaction(async (tx) => {
    await tx.query(
      `INSERT INTO session_repos
         (session_id, root_name, base_branch, base_sha_at_fork, session_branch, head_sha,
          dep_lockfile_hash, spec_doc_sha, container_image_digest, upstream_url, last_test_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        id,
        repo.rootName,
        repo.baseBranch,
        repo.baseShaAtFork,
        repo.sessionBranch,
        repo.headSha,
        repo.depLockfileHash,
        repo.specDocSha,
        repo.containerImageDigest,
        upstreamUrl,
        repo.lastTestStatus,
      ],
    );
    await tx.query(`UPDATE sessions SET root_name = $2 WHERE id = $1`, [id, repo.rootName]);
  });

  return getSession(id);
}

export async function setHeadSha(id: string, headSha: string): Promise<void> {
  await query(`UPDATE session_repos SET head_sha = $2 WHERE session_id = $1`, [id, headSha]);
}

/**
 * Marks a session as in use. Every repo read and write calls this, so idleness
 * means "nobody has opened it", not "nobody has committed to it".
 */
export async function touchSession(id: string, userId?: string): Promise<void> {
  await query(
    `UPDATE sessions SET last_active_at = now(), archived_at = NULL WHERE id = $1`,
    [id],
  );
  if (userId) {
    await query(
      `UPDATE session_members SET last_seen_at = now() WHERE session_id = $1 AND user_id = $2`,
      [id, userId],
    );
  }
}

export async function deleteSession(id: string): Promise<void> {
  await query(`DELETE FROM sessions WHERE id = $1`, [id]);
}

export async function markArchived(id: string): Promise<void> {
  await query(`UPDATE sessions SET archived_at = now() WHERE id = $1`, [id]);
}

/** Retention sweep input: everything not already deleted. */
export async function reapableSessions(): Promise<
  { id: string; lastActiveAt: number; pinned: boolean; archivedAt: number | null }[]
> {
  const rows = await query<{
    id: string;
    last_active_at: Date;
    pinned: boolean;
    archived_at: Date | null;
  }>(
    `SELECT id, last_active_at, pinned, archived_at
       FROM sessions WHERE deleted_at IS NULL`,
  );
  return rows.map((row) => ({
    id: row.id,
    lastActiveAt: row.last_active_at.getTime(),
    pinned: row.pinned,
    archivedAt: row.archived_at ? row.archived_at.getTime() : null,
  }));
}

// ---------------------------------------------------------------------------
// Membership — the durable roster that replaced the per-session cookie key
// ---------------------------------------------------------------------------

export async function roleOf(sessionId: string, userId: string): Promise<SessionRole | null> {
  const row = await queryOne<{ role: SessionRole }>(
    `SELECT role FROM session_members
      WHERE session_id = $1 AND user_id = $2 AND removed_at IS NULL`,
    [sessionId, userId],
  );
  return row?.role ?? null;
}

export async function addMember(
  sessionId: string,
  userId: string,
  role: SessionRole,
  addedVia: "owner" | "share_link" | "org",
  addedBy?: string,
): Promise<void> {
  await query(
    `INSERT INTO session_members (session_id, user_id, role, added_via, added_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (session_id, user_id)
     DO UPDATE SET removed_at = NULL, role = EXCLUDED.role`,
    [sessionId, userId, role, addedVia, addedBy ?? null],
  );
}

export async function removeMember(sessionId: string, userId: string): Promise<void> {
  await query(
    `UPDATE session_members SET removed_at = now()
      WHERE session_id = $1 AND user_id = $2 AND removed_at IS NULL`,
    [sessionId, userId],
  );
}

/** The roster, for the session's people list. */
export async function membersOf(sessionId: string): Promise<SessionMember[]> {
  const rows = await query<{
    user_id: string;
    handle: string;
    display_name: string;
    avatar_url: string | null;
    role: SessionRole;
    last_seen_at: Date | null;
  }>(
    `SELECT m.user_id, u.handle, u.display_name, u.avatar_url, m.role, m.last_seen_at
       FROM session_members m
       JOIN users u ON u.id = m.user_id
      WHERE m.session_id = $1 AND m.removed_at IS NULL
      ORDER BY m.joined_at`,
    [sessionId],
  );

  return rows.map((row) => ({
    userId: row.user_id,
    handle: row.handle,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    role: row.role,
    lastSeenAt: row.last_seen_at ? row.last_seen_at.getTime() : null,
    online: false,
  }));
}

export function joinCodeMatches(session: Session, candidate: string): boolean {
  return constantTimeEquals(
    session.joinCode.toUpperCase(),
    candidate.trim().toUpperCase().replace(/\s+/g, ""),
  );
}

/** Avoids leaking how much of a secret was correct through response timing. */
function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Mint an id from the session alphabet. Room repos (roomRepos.ts) share this
 * because a repo's disk location is derived from its id exactly like a
 * session's — `repos/<id>.git`, `work/<id>` — and the paths layer validates
 * against this alphabet (`isSessionId`).
 */
export function mintPathId(): string {
  return randomString(12, ID_ALPHABET);
}

function randomString(length: number, alphabet: string): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let index = 0; index < length; index += 1) {
    out += alphabet[bytes[index] % alphabet.length];
  }
  return out;
}

function cleanName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const trimmed = name.trim().replace(/\s+/g, " ").slice(0, 60);
  return trimmed.length > 0 ? trimmed : null;
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

type MessageRow = {
  id: string;
  user_id: string;
  display_name: string;
  handle: string;
  body: string;
  created_at: Date;
};

const toMessage = (row: MessageRow): ChatMessage => ({
  id: row.id,
  userId: row.user_id,
  userName: row.display_name,
  handle: row.handle,
  body: row.body,
  createdAt: row.created_at.getTime(),
});

export const MESSAGE_PAGE = 50;

/**
 * A page of history, newest-first from the index then reversed for display.
 *
 * `before` is a message id rather than a timestamp: ids are uuidv7 and so sort
 * by creation, which means paging cannot skip or repeat a message when two land
 * in the same millisecond.
 */
export async function listMessages(
  sessionId: string,
  before?: string,
): Promise<{ messages: ChatMessage[]; hasMore: boolean }> {
  const rows = await query<MessageRow>(
    `SELECT m.id, m.user_id, u.display_name, u.handle, m.body, m.created_at
       FROM session_messages m
       JOIN users u ON u.id = m.user_id
      WHERE m.session_id = $1
        AND m.deleted_at IS NULL
        AND ($2::uuid IS NULL OR m.id < $2::uuid)
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT $3`,
    [sessionId, before ?? null, MESSAGE_PAGE + 1],
  );

  const hasMore = rows.length > MESSAGE_PAGE;
  return {
    messages: rows.slice(0, MESSAGE_PAGE).reverse().map(toMessage),
    hasMore,
  };
}

export async function createMessage(
  sessionId: string,
  userId: string,
  body: string,
): Promise<ChatMessage> {
  const row = await queryOne<MessageRow>(
    `WITH inserted AS (
       INSERT INTO session_messages (session_id, user_id, body)
       VALUES ($1, $2, $3)
       RETURNING id, user_id, body, created_at
     )
     SELECT i.id, i.user_id, u.display_name, u.handle, i.body, i.created_at
       FROM inserted i JOIN users u ON u.id = i.user_id`,
    [sessionId, userId, body],
  );
  return toMessage(row!);
}
