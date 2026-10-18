import { createHash, randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { query, queryOne, transaction } from "../db/client";
import { isUuid } from "../ai/turns";
import type { ChatInvitation, ChatLinkRole, ChatShareRole, SharedChat, SharedComment, SharedMessage } from "./types";

export class SharingError extends Error {
  constructor(message: string, public status = 403) { super(message); }
}
const unavailable = () => new SharingError("This chat isn’t available to your account. Ask the host for a new invitation.");
const digest = (token: string) => createHash("sha256").update(token).digest();
const invitationColumns = `id,email,role,created_at::text AS "createdAt",expires_at::text AS "expiresAt",
  accepted_at::text AS "acceptedAt",revoked_at::text AS "revokedAt",token_hash IS NOT NULL AS "viaLink",
  EXISTS (SELECT 1 FROM chat_access_grants g WHERE g.invitation_id=chat_invitations.id) AS "workspaceAccess"`;
/** The strongest of a person's own access and what a chat link grants. */
const BEST_ROLE = `(SELECT x FROM unnest(ARRAY[shared_chat_role($1,$2),chat_link_role($1,$3)]) x WHERE x IS NOT NULL
  ORDER BY array_position(ARRAY['manager','editor','commenter','viewer'],x) LIMIT 1)`;
const linkToken = (link: unknown) => (typeof link === "string" && /^[\w-]{43}$/.test(link) ? link : null);

/** All sharing writes lock the run first, then invitation/comment rows. No
 * network, filesystem, AI calls or notifications belong inside these locks. */
async function lockChat(tx: PoolClient, runId: string) {
  if (!isUuid(runId)) throw unavailable();
  const { rows } = await tx.query("SELECT id FROM agent_runs WHERE id=$1 FOR NO KEY UPDATE", [runId]);
  if (!rows.length) throw unavailable();
}
async function requireManager(tx: PoolClient, runId: string, actor: string) {
  const { rows: [row] } = await tx.query("SELECT chat_share_manager($1,$2) AS allowed", [runId,actor]);
  if (!row.allowed) throw new SharingError("Only the chat’s current driver or room owner with edit access can manage invitations.");
}

/**
 * Give a person access by email, as documents are shared: no link to pass
 * on, and no expiry until the host removes them. `mode: "link"` is the
 * earlier one-time invitation link (7 days), still accepted.
 */
export async function createChatInvitation(runId: string, actor: string, input: unknown, mode: "email" | "link" = "link") {
  const value = input as { email?: unknown; role?: unknown } | null;
  const email = typeof value?.email === "string" ? value.email.trim().toLowerCase() : "";
  if (!email || email.length>254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new SharingError("Enter the email address of the person you want to invite.",400);
  if (!["viewer","commenter","editor"].includes(String(value?.role))) throw new SharingError("Choose Viewer, Commenter or Editor.",400);
  if (value!.role === "editor" && mode !== "email") throw new SharingError("Share by email to make someone an Editor.",400);
  const role = value!.role as ChatShareRole;
  const token = mode === "link" ? randomBytes(32).toString("base64url") : null;
  const invitation = await transaction(async tx => {
    await lockChat(tx,runId);
    await requireManager(tx,runId,actor);
    // A new invitation replaces old grants for this recipient, including a
    // previous comment grant. Downgrading never leaves a stronger link alive.
    await tx.query("UPDATE chat_invitations SET revoked_at=now() WHERE run_id=$1 AND email=$2 AND revoked_at IS NULL",[runId,email]);
    const { rows: [row] } = await tx.query<ChatInvitation>(`INSERT INTO chat_invitations(run_id,email,role,token_hash,created_by,expires_at)
      VALUES($1,$2,$3,$4,$5,${token ? "now()+interval '7 days'" : "NULL"}) RETURNING ${invitationColumns}`,[runId,email,role,token ? digest(token) : null,actor]);
    return row;
  });
  return { invitation, token };
}

export async function listChatInvitations(runId: string, actor: string): Promise<ChatInvitation[]> {
  if (!isUuid(runId)) throw unavailable();
  if (!(await queryOne<{allowed:boolean}>("SELECT chat_share_manager($1,$2) AS allowed",[runId,actor]))?.allowed) throw unavailable();
  return query<ChatInvitation>(`SELECT ${invitationColumns} FROM chat_invitations
    WHERE run_id=$1 AND chat_share_manager(run_id,$2) ORDER BY created_at DESC LIMIT 100`,[runId,actor]);
}

export async function revokeChatInvitation(runId: string, actor: string, id: unknown) {
  if (!isUuid(id)) throw new SharingError("Choose an invitation to remove.",400);
  await transaction(async tx => {
    await lockChat(tx,runId);
    await requireManager(tx,runId,actor);
    const result = await tx.query("UPDATE chat_invitations SET revoked_at=COALESCE(revoked_at,now()) WHERE run_id=$1 AND id=$2 RETURNING id",[runId,id]);
    if (!result.rows.length) throw new SharingError("That invitation no longer exists.",404);
  });
}

export async function acceptChatInvitation(runId: string, actor: string, token: unknown) {
  if (typeof token!=="string" || !/^[\w-]{43}$/.test(token)) throw unavailable();
  await transaction(async tx => {
    await lockChat(tx,runId);
    const { rows: [invite] } = await tx.query(`SELECT i.*,u.email AS actor_email,u.email_verified_at,
      chat_guest_eligible(i.run_id,$3) AS eligible,chat_share_issuer_active(i.run_id,i.created_by) AS issuer_allowed
      FROM chat_invitations i JOIN users u ON u.id=$3
      WHERE i.run_id=$1 AND i.token_hash=$2 AND i.revoked_at IS NULL AND i.expires_at>now()
      FOR UPDATE OF i`,[runId,digest(token),actor]);
    if (!invite || !invite.eligible || !invite.issuer_allowed) throw unavailable();
    if (!invite.email_verified_at) throw new SharingError("Verify your email before accepting this invitation. Sign in again to complete email verification, then reopen the link.");
    if (invite.email.toLowerCase()!==invite.actor_email.toLowerCase()) {
      throw new SharingError("This invitation is for a different email address. Sign in with the email the host invited.");
    }
    if (invite.accepted_by && invite.accepted_by!==actor) throw unavailable();
    await tx.query("UPDATE chat_invitations SET accepted_by=$2,accepted_at=COALESCE(accepted_at,now()) WHERE id=$1",[invite.id,actor]);
  });
}

/** Each data query repeats authorization, so a stale page/earlier check grants
 * nothing. Only human/AI text is exposed; no files, tools, room events or keys. */
export async function readSharedChat(runId: string, actor: string | null, after = 0, commentsBefore?: string, link?: unknown): Promise<SharedChat> {
  if (!isUuid(runId)) throw unavailable();
  const token = linkToken(link);
  const chat = await queryOne<{ id:string; title:string; hostName:string; role:SharedChat["role"]; personal:boolean }>(`SELECT r.id,COALESCE(r.title,'Shared chat') AS title,
    u.display_name AS "hostName",${BEST_ROLE} AS role,shared_chat_role(r.id,$2) IS NOT NULL AS personal
    FROM agent_runs r JOIN users u ON u.id=r.driver_user_id
    WHERE r.id=$1 AND ${BEST_ROLE} IS NOT NULL`,[runId,actor,token]);
  if (!chat) throw unavailable();
  // Someone added by email has now opened it: shown to the host as "Opened".
  if (actor && chat.personal) await query(`UPDATE chat_invitations i SET accepted_by=$2,accepted_at=now() FROM users u
    WHERE i.run_id=$1 AND u.id=$2 AND i.email=u.email AND u.email_verified_at IS NOT NULL
      AND i.token_hash IS NULL AND i.accepted_by IS NULL AND i.revoked_at IS NULL`,[runId,actor]);
  const messages = await query<SharedMessage>(`WITH permission AS MATERIALIZED (SELECT ${BEST_ROLE} AS role)
    SELECT m.id,m.seq::int,m.role,m.body,u.display_name AS "authorName",m.created_at::text AS "createdAt"
    FROM agent_run_messages m CROSS JOIN permission LEFT JOIN users u ON u.id=m.author_user_id
    WHERE m.run_id=$1 AND m.seq>$4 AND m.role IN ('user','agent') AND permission.role IS NOT NULL
    ORDER BY m.seq LIMIT 101`,[runId,actor,token,Number.isSafeInteger(after)&&after>=0?after:0]);
  if (commentsBefore && !isUuid(commentsBefore)) throw new SharingError("Invalid comment page.",400);
  const comments = await query<SharedComment>(`WITH permission AS MATERIALIZED (SELECT ${BEST_ROLE} AS role)
    SELECT c.id,c.body,u.display_name AS "authorName",c.created_at::text AS "createdAt"
    FROM shared_chat_comments c CROSS JOIN permission JOIN users u ON u.id=c.user_id
    WHERE c.run_id=$1 AND permission.role IS NOT NULL
      AND ($4::uuid IS NULL OR (c.created_at,c.id)<(SELECT created_at,id FROM shared_chat_comments WHERE id=$4 AND run_id=$1))
    ORDER BY c.created_at DESC,c.id DESC LIMIT 101`,[runId,actor,token,commentsBefore??null]);
  // If a concurrent revoke happened during pagination, send no stale payload.
  const current=await queryOne<{role:SharedChat["role"]|null;personal:boolean}>(`SELECT ${BEST_ROLE} AS role,shared_chat_role($1,$2) IS NOT NULL AS personal`,[runId,actor,token]);
  if (!current?.role) throw unavailable();
  const workspace=actor?await queryOne<{session_id:string}>("SELECT session_id FROM agent_runs WHERE id=$1 AND room_access_role(session_id,$2) IS NOT NULL",[runId,actor]):null;
  return {id:chat.id,title:chat.title,hostName:chat.hostName,role:current.role,signedIn:!!actor,viaLink:!current.personal,
    messages:messages.slice(0,100),hasMore:messages.length>100,comments:comments.slice(0,100).reverse(),commentsHaveMore:comments.length>100,
    ...(workspace?{workspacePath:`/s/${workspace.session_id}?run=${runId}`}:{})};
}

export async function addSharedComment(runId: string, actor: string, input: unknown, link?: unknown): Promise<SharedComment> {
  const value = input as {id?:unknown;body?:unknown}|null;
  if (!isUuid(value?.id) || typeof value?.body!=="string" || !value.body.trim() || value.body.length>8000) throw new SharingError("Enter a comment of 1–8,000 characters.",400);
  const id = value.id, body = value.body.trim();
  return transaction(async tx => {
    await lockChat(tx,runId);
    // Roster suspension/removal revokes invitations without taking the run
    // lock. Wait for those writes before authorizing a guest's comment.
    await tx.query(`SELECT i.id FROM chat_invitations i JOIN users u ON u.id=$2 AND u.email=i.email
      WHERE i.run_id=$1 AND i.revoked_at IS NULL AND (i.expires_at IS NULL OR i.expires_at>now())
        AND (i.accepted_by=$2 OR (i.token_hash IS NULL AND i.accepted_by IS NULL)) FOR SHARE OF i`,[runId,actor]);
    await tx.query("SELECT run_id FROM chat_links WHERE run_id=$1 FOR SHARE",[runId]);
    // A link that lets anyone comment still needs a signed-in, eligible person.
    const {rows:[access]} = await tx.query(`SELECT ${BEST_ROLE} AS role,
      room_access_role(r.session_id,$2) AS room_role,chat_guest_eligible(r.id,$2) AS eligible FROM agent_runs r WHERE r.id=$1`,[runId,actor,linkToken(link)]);
    if (!access?.eligible || (!["manager","editor","commenter"].includes(access.role) && !["owner","editor"].includes(access.room_role))) throw new SharingError("You have view-only access or this invitation has ended.");
    await tx.query("INSERT INTO shared_chat_comments(id,run_id,user_id,body) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING",[id,runId,actor,body]);
    const {rows:[comment]} = await tx.query<SharedComment>(`SELECT c.id,c.body,u.display_name AS "authorName",c.created_at::text AS "createdAt"
      FROM shared_chat_comments c JOIN users u ON u.id=c.user_id WHERE c.id=$1 AND c.run_id=$2 AND c.user_id=$3 AND c.body=$4`,[id,runId,actor,body]);
    if (!comment) throw new SharingError("This request already belongs to a different comment.",409);
    return comment;
  });
}

export async function listSharedChats(actor: string) {
  return query<{id:string;title:string;hostName:string}>(`SELECT DISTINCT r.id,COALESCE(r.title,'Shared chat') AS title,u.display_name AS "hostName"
    FROM chat_invitations i JOIN agent_runs r ON r.id=i.run_id JOIN users u ON u.id=r.driver_user_id JOIN users me ON me.id=$1
    WHERE (i.accepted_by=$1 OR (i.token_hash IS NULL AND i.email=me.email AND i.revoked_at IS NULL))
      AND shared_chat_role(r.id,$1) IS NOT NULL ORDER BY title LIMIT 100`,[actor]);
}

export type ChatLink = { role: ChatLinkRole; token: string } | null;

/** "Anyone with the link": the chat's link and what it allows, or null when only added people can open it. */
export async function getChatLink(runId: string, actor: string): Promise<ChatLink> {
  if (!isUuid(runId)) throw unavailable();
  if (!(await queryOne<{allowed:boolean}>("SELECT chat_share_manager($1,$2) AS allowed",[runId,actor]))?.allowed) throw unavailable();
  return (await queryOne<{role:ChatLinkRole;token:string}>("SELECT role,token FROM chat_links WHERE run_id=$1",[runId])) ?? null;
}

/** Turn link sharing on (keeping an existing link), change what it allows, or turn it off (null). */
export async function setChatLink(runId: string, actor: string, role: unknown): Promise<ChatLink> {
  if (role !== null && !["viewer","commenter"].includes(String(role))) throw new SharingError("Choose Viewer, Commenter or Restricted.",400);
  return transaction(async tx => {
    await lockChat(tx,runId);
    await requireManager(tx,runId,actor);
    if (role === null) { await tx.query("DELETE FROM chat_links WHERE run_id=$1",[runId]); return null; }
    const {rows:[row]} = await tx.query<{role:ChatLinkRole;token:string}>(`INSERT INTO chat_links(run_id,token,role,created_by) VALUES($1,$2,$3,$4)
      ON CONFLICT(run_id) DO UPDATE SET role=EXCLUDED.role RETURNING role,token`,[runId,randomBytes(32).toString("base64url"),role,actor]);
    return row;
  });
}

/** Shares this person started in the last hour, to keep notification email from becoming a spam relay. */
export async function recentShares(actor: string) {
  return (await queryOne<{n:number}>("SELECT count(*)::int AS n FROM chat_invitations WHERE created_by=$1 AND created_at>now()-interval '1 hour'",[actor]))?.n ?? 0;
}

/** An Editor's invitation that has been opened but not yet turned into editing access. */
export async function pendingEditorInvitation(runId: string, actor: string): Promise<string | null> {
  if (!isUuid(runId)) return null;
  return (await queryOne<{ id: string }>(`SELECT i.id FROM chat_invitations i
    WHERE i.run_id=$1 AND i.accepted_by=$2 AND i.role='editor' AND i.revoked_at IS NULL AND (i.expires_at IS NULL OR i.expires_at>now())
      AND NOT EXISTS (SELECT 1 FROM chat_access_grants g WHERE g.invitation_id=i.id)
    ORDER BY i.created_at DESC LIMIT 1`, [runId, actor]))?.id ?? null;
}
