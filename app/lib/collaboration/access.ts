import type { PoolClient } from "pg";
import { isUuid } from "../ai/turns";
import { SharingError } from "../sharing/store";

export type ChatAccess = {
  id: string; sessionId: string; repoId: string | null; baseSha: string;
  seq: string; status: string; roomRole: string | null; guestRole: string | null;
  driverId: string; ownerId: string; orgId: string | null; projectId: string | null;
};
export async function chatAccess(tx: Pick<PoolClient,"query">, runId: string, actor: string, lock = false): Promise<ChatAccess> {
  if (!isUuid(runId)) throw new SharingError("This conversation is not available.");
  // A lock wait may outlive the permission snapshot of its statement. Resolve
  // authority in a fresh statement after acquiring the lock.
  if(lock) await tx.query('SELECT id FROM agent_runs WHERE id=$1 FOR NO KEY UPDATE',[runId]);
  const {rows:[row]} = await tx.query<ChatAccess>(`SELECT r.id,r.session_id AS "sessionId",r.repo_id AS "repoId",r.base_sha AS "baseSha",
    r.message_seq::text AS seq,r.status,r.driver_user_id AS "driverId",s.owner_id AS "ownerId",s.org_id AS "orgId",s.project_id AS "projectId",
    room_access_role(s.id,$2) AS "roomRole",shared_chat_role(r.id,$2) AS "guestRole"
    FROM agent_runs r JOIN sessions s ON s.id=r.session_id
    WHERE r.id=$1 AND chat_guest_eligible(r.id,$2)`, [runId,actor]);
  if (!row || (!row.roomRole && !row.guestRole)) throw new SharingError("This conversation is not available. Ask the host for access.");
  return row;
}
export const canEditChat = (chat: ChatAccess) => ["owner","editor"].includes(chat.roomRole ?? "");
export function requireEditor(chat: ChatAccess) {
  if (!canEditChat(chat)) throw new SharingError("You need workspace editing access for this action.");
}
export async function currentHead(tx: Pick<PoolClient,"query">, chat: ChatAccess, lock = false): Promise<string | null> {
  const {rows:[repo]} = chat.repoId
    ? await tx.query(`SELECT head_sha FROM room_repos WHERE id=$1 AND session_id=$2 AND seeded_at IS NOT NULL ${lock ? "FOR UPDATE" : ""}`, [chat.repoId,chat.sessionId])
    : await tx.query(`SELECT head_sha FROM session_repos WHERE session_id=$1 ${lock ? "FOR UPDATE" : ""}`, [chat.sessionId]);
  return repo?.head_sha || null;
}
