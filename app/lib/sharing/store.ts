import { createHash, randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { query, queryOne, transaction } from "../db/client";
import { isUuid } from "../ai/turns";
import type { ChatInvitation, ChatShareRole, SharedChat, SharedComment, SharedMessage } from "./types";

export class SharingError extends Error {
  constructor(message: string, public status = 403) { super(message); }
}
const unavailable = () => new SharingError("This chat isn’t available to your account. Ask the host for a new invitation.");
const digest = (token: string) => createHash("sha256").update(token).digest();
const invitationColumns = `id,email,role,created_at::text AS "createdAt",expires_at::text AS "expiresAt",
  accepted_at::text AS "acceptedAt",revoked_at::text AS "revokedAt"`;

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

export async function createChatInvitation(runId: string, actor: string, input: unknown) {
  const value = input as { email?: unknown; role?: unknown } | null;
  const email = typeof value?.email === "string" ? value.email.trim().toLowerCase() : "";
  if (!email || email.length>254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new SharingError("Enter the email address of the person you want to invite.",400);
  if (!["viewer","commenter"].includes(String(value?.role))) throw new SharingError("Choose Can view or Can comment.",400);
  const role = value!.role as ChatShareRole;
  const token = randomBytes(32).toString("base64url");
  const invitation = await transaction(async tx => {
    await lockChat(tx,runId);
    await requireManager(tx,runId,actor);
    // A new invitation replaces old grants for this recipient, including a
    // previous comment grant. Downgrading never leaves a stronger link alive.
    await tx.query("UPDATE chat_invitations SET revoked_at=now() WHERE run_id=$1 AND email=$2 AND revoked_at IS NULL",[runId,email]);
    const { rows: [row] } = await tx.query<ChatInvitation>(`INSERT INTO chat_invitations(run_id,email,role,token_hash,created_by)
      VALUES($1,$2,$3,$4,$5) RETURNING ${invitationColumns}`,[runId,email,role,digest(token),actor]);
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
export async function readSharedChat(runId: string, actor: string, after = 0, commentsBefore?: string): Promise<SharedChat> {
  if (!isUuid(runId)) throw unavailable();
  const chat = await queryOne<{ id:string; title:string; hostName:string; role:SharedChat["role"] }>(`SELECT r.id,COALESCE(r.title,'Shared chat') AS title,
    u.display_name AS "hostName",shared_chat_role(r.id,$2) AS role
    FROM agent_runs r JOIN users u ON u.id=r.driver_user_id
    WHERE r.id=$1 AND shared_chat_role(r.id,$2) IS NOT NULL`,[runId,actor]);
  if (!chat) throw unavailable();
  const messages = await query<SharedMessage>(`WITH permission AS MATERIALIZED (SELECT shared_chat_role($1,$2) AS role)
    SELECT m.id,m.seq::int,m.role,m.body,u.display_name AS "authorName",m.created_at::text AS "createdAt"
    FROM agent_run_messages m CROSS JOIN permission LEFT JOIN users u ON u.id=m.author_user_id
    WHERE m.run_id=$1 AND m.seq>$3 AND m.role IN ('user','agent') AND permission.role IS NOT NULL
    ORDER BY m.seq LIMIT 101`,[runId,actor,Number.isSafeInteger(after)&&after>=0?after:0]);
  if (commentsBefore && !isUuid(commentsBefore)) throw new SharingError("Invalid comment page.",400);
  const comments = await query<SharedComment>(`WITH permission AS MATERIALIZED (SELECT shared_chat_role($1,$2) AS role)
    SELECT c.id,c.body,u.display_name AS "authorName",c.created_at::text AS "createdAt"
    FROM shared_chat_comments c CROSS JOIN permission JOIN users u ON u.id=c.user_id
    WHERE c.run_id=$1 AND permission.role IS NOT NULL
      AND ($3::uuid IS NULL OR (c.created_at,c.id)<(SELECT created_at,id FROM shared_chat_comments WHERE id=$3 AND run_id=$1))
    ORDER BY c.created_at DESC,c.id DESC LIMIT 101`,[runId,actor,commentsBefore??null]);
  // If a concurrent revoke happened during pagination, send no stale payload.
  const current=await queryOne<{role:SharedChat["role"]|null}>("SELECT shared_chat_role($1,$2) AS role",[runId,actor]);
  if (!current?.role) throw unavailable();
  const workspace=await queryOne<{session_id:string}>("SELECT session_id FROM agent_runs WHERE id=$1 AND room_access_role(session_id,$2) IS NOT NULL",[runId,actor]);
  return {...chat,role:current.role,messages:messages.slice(0,100),hasMore:messages.length>100,comments:comments.slice(0,100).reverse(),commentsHaveMore:comments.length>100,
    ...(workspace?{workspacePath:`/s/${workspace.session_id}?run=${runId}`}:{})};
}

export async function addSharedComment(runId: string, actor: string, input: unknown): Promise<SharedComment> {
  const value = input as {id?:unknown;body?:unknown}|null;
  if (!isUuid(value?.id) || typeof value?.body!=="string" || !value.body.trim() || value.body.length>8000) throw new SharingError("Enter a comment of 1–8,000 characters.",400);
  const id = value.id, body = value.body.trim();
  return transaction(async tx => {
    await lockChat(tx,runId);
    // Roster suspension/removal revokes invitations without taking the run
    // lock. Wait for those writes before authorizing a guest's comment.
    await tx.query(`SELECT i.id FROM chat_invitations i JOIN users u ON u.id=$2 AND u.email=i.email
      WHERE i.run_id=$1 AND i.accepted_by=$2 AND i.revoked_at IS NULL AND i.expires_at>now() FOR SHARE OF i`,[runId,actor]);
    const {rows:[access]} = await tx.query(`SELECT shared_chat_role(r.id,$2) AS role,
      room_access_role(r.session_id,$2) AS room_role,chat_guest_eligible(r.id,$2) AS eligible FROM agent_runs r WHERE r.id=$1`,[runId,actor]);
    if (!access?.eligible || (!["manager","commenter"].includes(access.role) && !["owner","editor"].includes(access.room_role))) throw new SharingError("You have view-only access or this invitation has ended.");
    await tx.query("INSERT INTO shared_chat_comments(id,run_id,user_id,body) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING",[id,runId,actor,body]);
    const {rows:[comment]} = await tx.query<SharedComment>(`SELECT c.id,c.body,u.display_name AS "authorName",c.created_at::text AS "createdAt"
      FROM shared_chat_comments c JOIN users u ON u.id=c.user_id WHERE c.id=$1 AND c.run_id=$2 AND c.user_id=$3 AND c.body=$4`,[id,runId,actor,body]);
    if (!comment) throw new SharingError("This request already belongs to a different comment.",409);
    return comment;
  });
}

export async function listSharedChats(actor: string) {
  return query<{id:string;title:string;hostName:string}>(`SELECT DISTINCT r.id,COALESCE(r.title,'Shared chat') AS title,u.display_name AS "hostName"
    FROM chat_invitations i JOIN agent_runs r ON r.id=i.run_id JOIN users u ON u.id=r.driver_user_id
    WHERE i.accepted_by=$1 AND shared_chat_role(r.id,$1) IS NOT NULL ORDER BY title LIMIT 100`,[actor]);
}
