import type { PoolClient } from "pg";
import { isUuid } from "../ai/turns";
import { isUniqueViolation, query, queryOne, transaction } from "../db/client";
import type {
  ChatMessage,
  Conversation,
  ConversationKind,
  ConversationMember,
  ConversationRole,
  ConversationSummary,
  ConversationVisibility,
} from "./types";

/** A conversation stripped to what the auth guard and write paths need. */
export type ConversationLite = {
  id: string;
  orgId: string;
  kind: ConversationKind;
  visibility: ConversationVisibility;
};

type ConversationRow = {
  id: string;
  org_id: string;
  kind: ConversationKind;
  name: string | null;
  topic: string | null;
  visibility: ConversationVisibility;
  dm_key: string | null;
};

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

// ---------------------------------------------------------------------------
// Access primitives (used by the auth guard)
// ---------------------------------------------------------------------------

export class ChatAccessError extends Error {
  constructor() { super("You no longer have access to this conversation."); }
}

export async function conversationForUser(id: string, userId: string): Promise<{
  conversation: ConversationLite; role: ConversationRole | null;
} | null> {
  if (!isUuid(id) || !isUuid(userId)) return null;
  const row = await queryOne<{ id: string; org_id: string; kind: ConversationKind;
    visibility: ConversationVisibility; role: ConversationRole | "public" }>(
    `SELECT id, org_id, kind, visibility, conversation_access_role(id, $2) AS role
       FROM conversations WHERE id = $1 AND conversation_access_role(id, $2) IS NOT NULL`, [id, userId]);
  return row ? { conversation: { id: row.id, orgId: row.org_id, kind: row.kind, visibility: row.visibility },
    role: row.role === "public" ? null : row.role } : null;
}

export async function isActiveOrgMember(orgId: string, userId: string): Promise<boolean> {
  if (!isUuid(userId)) return false;
  return !!await queryOne(`SELECT 1 FROM org_members om
    JOIN orgs o ON o.id = om.org_id AND o.deleted_at IS NULL
    JOIN users u ON u.id = om.user_id AND u.deleted_at IS NULL
    WHERE om.org_id = $1 AND om.user_id = $2 AND om.status = 'active'`, [orgId, userId]);
}

/** Hold authorization stable until the write commits, including concurrent suspension. */
async function lockActiveMembers(tx: PoolClient, orgId: string, users: string[]) {
  const ids = [...new Set(users)].sort();
  const { rows } = await tx.query(`SELECT om.user_id FROM org_members om
    JOIN orgs o ON o.id = om.org_id AND o.deleted_at IS NULL
    JOIN users u ON u.id = om.user_id AND u.deleted_at IS NULL
    WHERE om.org_id = $1 AND om.user_id = ANY($2::uuid[]) AND om.status = 'active'
    ORDER BY om.user_id FOR SHARE OF om, u`, [orgId, ids]);
  if (rows.length !== ids.length) throw new ChatAccessError();
}

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

/**
 * Records a membership (or revives a removed one) without ever downgrading an
 * existing role — opening a public channel should give a former owner their
 * last-read tracking back, not demote them.
 */
export async function ensureMember(
  conversationId: string,
  orgId: string,
  userId: string,
  role: ConversationRole = "member",
): Promise<boolean> {
  try {
    return await transaction(async tx => {
      const { rows: [conversation] } = await tx.query(`SELECT org_id FROM conversations WHERE id=$1 FOR SHARE`, [conversationId]);
      if (!conversation || conversation.org_id !== orgId) return false;
      await lockActiveMembers(tx, orgId, [userId]);
      // Hold the membership through the upsert: a concurrently revoked private
      // membership must not be revived using an earlier statement's snapshot.
      await tx.query(`SELECT user_id FROM conversation_members WHERE conversation_id=$1 AND user_id=$2 FOR UPDATE`, [conversationId, userId]);
      const { rows } = await tx.query(
        `INSERT INTO conversation_members (conversation_id, org_id, user_id, role, added_by)
         SELECT $1, $2, $3, $4, $3 WHERE conversation_access_role($1, $3) IS NOT NULL
         ON CONFLICT (conversation_id, user_id) DO UPDATE SET removed_at = NULL
         RETURNING user_id`, [conversationId, orgId, userId, role]);
      return rows.length > 0;
    });
  } catch (cause) {
    if (cause instanceof ChatAccessError) return false;
    throw cause;
  }
}

export async function markRead(conversationId: string, userId: string): Promise<void> {
  await query(
    `UPDATE conversation_members SET last_read_at = now()
      WHERE conversation_id = $1 AND user_id = $2
        AND conversation_access_role($1, $2) IS NOT NULL`,
    [conversationId, userId],
  );
}

export async function listMembers(conversationId: string): Promise<ConversationMember[]> {
  const rows = await query<{
    user_id: string;
    handle: string;
    display_name: string;
    avatar_url: string | null;
    role: ConversationRole;
  }>(
    `SELECT cm.user_id, u.handle, u.display_name, u.avatar_url, cm.role
       FROM conversation_members cm
       JOIN users u ON u.id = cm.user_id
      WHERE cm.conversation_id = $1 AND cm.removed_at IS NULL
      ORDER BY cm.joined_at`,
    [conversationId],
  );
  return rows.map((r) => ({
    userId: r.user_id,
    handle: r.handle,
    displayName: r.display_name,
    avatarUrl: r.avatar_url,
    role: r.role,
  }));
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * The conversations this account can see in an org: every public channel, plus
 * the private channels and DMs it is a member of. Carries an unread count, a
 * one-line preview, and (for a DM) the other participant, all in one query so
 * the sidebar renders without an N+1.
 */
export async function listConversations(
  orgId: string,
  userId: string,
): Promise<ConversationSummary[]> {
  const rows = await query<{
    id: string;
    kind: ConversationKind;
    name: string | null;
    visibility: ConversationVisibility;
    last_message_at: Date | null;
    unread: number;
    last_body: string | null;
    last_at: Date | null;
    last_author: string | null;
    other_user_id: string | null;
    other_name: string | null;
  }>(
    `SELECT c.id, c.kind, c.name, c.visibility, c.last_message_at,
            CASE WHEN cm.user_id IS NULL THEN 0 ELSE (
              SELECT count(*)::int FROM chat_messages m
                WHERE m.conversation_id = c.id AND m.deleted_at IS NULL
                  AND m.user_id <> $2 AND m.created_at > cm.last_read_at
            ) END AS unread,
            lm.body AS last_body, lm.created_at AS last_at, lu.display_name AS last_author,
            other.user_id AS other_user_id, other.display_name AS other_name
       FROM conversations c
       LEFT JOIN conversation_members cm
         ON cm.conversation_id = c.id AND cm.user_id = $2 AND cm.removed_at IS NULL
       LEFT JOIN LATERAL (
         SELECT body, created_at, user_id FROM chat_messages
          WHERE conversation_id = c.id AND deleted_at IS NULL
          ORDER BY created_at DESC, id DESC LIMIT 1
       ) lm ON true
       LEFT JOIN users lu ON lu.id = lm.user_id
       LEFT JOIN LATERAL (
         SELECT m.user_id, u.display_name FROM conversation_members m
           JOIN users u ON u.id = m.user_id
          WHERE m.conversation_id = c.id AND m.user_id <> $2 AND m.removed_at IS NULL
          LIMIT 1
       ) other ON c.kind = 'dm'
      WHERE c.org_id = $1 AND c.deleted_at IS NULL
        AND conversation_access_role(c.id, $2) IS NOT NULL
      ORDER BY COALESCE(c.last_message_at, '-infinity'::timestamptz) DESC, c.name ASC`,
    [orgId, userId],
  );

  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    name: r.kind === "dm" ? (r.other_name ?? "Direct message") : (r.name ?? "channel"),
    visibility: r.visibility,
    unread: r.unread,
    lastMessageAt: r.last_message_at ? r.last_message_at.getTime() : null,
    lastPreview:
      r.last_body != null && r.last_at != null
        ? { body: r.last_body, author: r.last_author ?? "", at: r.last_at.getTime() }
        : null,
    otherUserId: r.other_user_id,
  }));
}

/** The full conversation for the open pane, with its roster and the caller's role. */
export async function loadConversation(
  conversationId: string,
  userId: string,
): Promise<Conversation | null> {
  const row = await queryOne<ConversationRow>(
    `SELECT id, org_id, kind, name, topic, visibility, dm_key
       FROM conversations
      WHERE id = $1 AND conversation_access_role(id, $2) IS NOT NULL`,
    [conversationId, userId],
  );
  if (!row) return null;

  const members = await listMembers(conversationId);
  const mine = members.find((m) => m.userId === userId) ?? null;

  let name = row.name ?? "channel";
  let otherUserId: string | null = null;
  if (row.kind === "dm") {
    const other = members.find((m) => m.userId !== userId) ?? null;
    name = other?.displayName ?? "Direct message";
    otherUserId = other?.userId ?? null;
  }

  return {
    id: row.id,
    orgId: row.org_id,
    kind: row.kind,
    name,
    topic: row.topic,
    visibility: row.visibility,
    otherUserId,
    members,
    myRole: mine?.role ?? null,
  };
}

export const MESSAGE_PAGE = 50;

/**
 * A page of history, newest-first from the index then reversed for display.
 * The cursor uses the same (created_at, id) order as the index, including on
 * PostgreSQL versions where new_id() uses random UUIDs.
 */
export async function listMessages(
  conversationId: string,
  userId: string,
  before?: string,
): Promise<{ messages: ChatMessage[]; hasMore: boolean }> {
  const rows = await query<MessageRow>(
    `SELECT m.id, m.user_id, u.display_name, u.handle, m.body, m.created_at
       FROM chat_messages m
       JOIN users u ON u.id = m.user_id
      WHERE m.conversation_id = $1
        AND m.deleted_at IS NULL
        AND conversation_access_role($1, $4) IS NOT NULL
        AND ($2::uuid IS NULL OR (m.created_at, m.id) < (
          SELECT created_at, id FROM chat_messages WHERE id = $2 AND conversation_id = $1
        ))
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT $3`,
    [conversationId, before ?? null, MESSAGE_PAGE + 1, userId],
  );

  const hasMore = rows.length > MESSAGE_PAGE;
  return {
    messages: rows.slice(0, MESSAGE_PAGE).reverse().map(toMessage),
    hasMore,
  };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function createMessage(
  conversationId: string,
  userId: string,
  body: string,
): Promise<ChatMessage> {
  return transaction(async (tx) => {
    const { rows: [conversation] } = await tx.query(`SELECT org_id FROM conversations WHERE id = $1 FOR UPDATE`, [conversationId]);
    if (!conversation) throw new ChatAccessError();
    await lockActiveMembers(tx, conversation.org_id, [userId]);
    await tx.query(`SELECT user_id FROM conversation_members WHERE conversation_id = $1 AND user_id = $2 FOR SHARE`, [conversationId, userId]);
    const inserted = await tx.query<MessageRow>(
      `WITH inserted AS (
         INSERT INTO chat_messages (conversation_id, user_id, body)
         SELECT $1, $2, $3 WHERE conversation_access_role($1, $2) IS NOT NULL
         RETURNING id, user_id, body, created_at
       )
       SELECT i.id, i.user_id, u.display_name, u.handle, i.body, i.created_at
         FROM inserted i JOIN users u ON u.id = i.user_id`,
      [conversationId, userId, body],
    );
    if (!inserted.rows.length) throw new ChatAccessError();
    // Posting joins a public channel in the same authorized transaction. Keep
    // an existing owner role intact and start the sender's read tracking.
    await tx.query(`INSERT INTO conversation_members(conversation_id,org_id,user_id,role,added_by)
      VALUES ($1,$2,$3,'member',$3)
      ON CONFLICT(conversation_id,user_id) DO UPDATE SET removed_at=NULL`, [conversationId,conversation.org_id,userId]);
    // The sidebar orders by most-recent activity; sending is reading up to now.
    await tx.query(`UPDATE conversations SET last_message_at = now() WHERE id = $1`, [
      conversationId,
    ]);
    await tx.query(
      `UPDATE conversation_members SET last_read_at = now()
        WHERE conversation_id = $1 AND user_id = $2`,
      [conversationId, userId],
    );
    return toMessage(inserted.rows[0]);
  });
}

/** Creates a channel and seeds its roster: the creator as owner, and — for a
 *  private channel — any org members passed in. Returns the new conversation id. */
export async function createChannel(
  orgId: string,
  userId: string,
  name: string,
  visibility: ConversationVisibility,
  memberIds: string[] = [],
): Promise<string> {
  return transaction(async (tx) => {
    await lockActiveMembers(tx, orgId, [userId]);
    const created = await tx.query<{ id: string }>(
      `INSERT INTO conversations (org_id, kind, name, visibility, created_by)
       VALUES ($1, 'channel', $2, $3, $4)
       RETURNING id`,
      [orgId, name, visibility, userId],
    );
    const id = created.rows[0].id;

    await tx.query(
      `INSERT INTO conversation_members (conversation_id, org_id, user_id, role, added_by)
       VALUES ($1, $2, $3, 'owner', $3)`,
      [id, orgId, userId],
    );

    const seed = [...new Set(memberIds.filter((m) => m && m !== userId))];
    for (const member of seed) {
      // EXISTS guard keeps a non-member id from turning the FK into a 500.
      await tx.query(
        `INSERT INTO conversation_members (conversation_id, org_id, user_id, role, added_by)
         SELECT $1, $2, $3, 'member', $4
          WHERE EXISTS (
            SELECT 1 FROM org_members
             WHERE org_id = $2 AND user_id = $3 AND status = 'active'
          )
         ON CONFLICT (conversation_id, user_id) DO NOTHING`,
        [id, orgId, member, userId],
      );
    }

    return id;
  });
}

/** Finds the DM between two org members, or opens it. Idempotent: the same pair
 *  always resolves to one conversation, even under a concurrent first-open. */
export async function getOrCreateDm(
  orgId: string,
  userId: string,
  otherUserId: string,
): Promise<string> {
  const key = [userId, otherUserId].sort().join(":");

  try {
    return await transaction(async (tx) => {
      await lockActiveMembers(tx, orgId, [userId, otherUserId]);
      const { rows: [existing] } = await tx.query<{ id: string }>(
        `SELECT id FROM conversations WHERE org_id = $1 AND kind = 'dm' AND dm_key = $2 AND deleted_at IS NULL`, [orgId, key]);
      if (existing) {
        // Org removal cascades memberships. Rejoining the org and explicitly
        // reopening a DM must recreate the missing rows as well as revive them.
        await tx.query(`INSERT INTO conversation_members(conversation_id,org_id,user_id,role,added_by)
          SELECT $1,$2,member,'member',$3 FROM unnest($4::uuid[]) AS member
          ON CONFLICT(conversation_id,user_id) DO UPDATE SET removed_at=NULL`,
        [existing.id, orgId, userId, [userId, otherUserId]]);
        return existing.id;
      }
      const created = await tx.query<{ id: string }>(
        `INSERT INTO conversations (org_id, kind, visibility, dm_key, created_by)
         VALUES ($1, 'dm', 'private', $2, $3)
         RETURNING id`,
        [orgId, key, userId],
      );
      const id = created.rows[0].id;
      await tx.query(
        `INSERT INTO conversation_members (conversation_id, org_id, user_id, role, added_by)
         VALUES ($1, $2, $3, 'member', $3), ($1, $2, $4, 'member', $3)`,
        [id, orgId, userId, otherUserId],
      );
      return id;
    });
  } catch (cause) {
    // Lost a race to create the same pair's DM — take the winner's row.
    if (isUniqueViolation(cause)) {
      const row = await queryOne<{ id: string }>(
        `SELECT id FROM conversations
          WHERE org_id = $1 AND kind = 'dm' AND dm_key = $2 AND deleted_at IS NULL`,
        [orgId, key],
      );
      if (row) return row.id;
    }
    throw cause;
  }
}
