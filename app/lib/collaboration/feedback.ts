import { transaction, query } from "../db/client";
import { SharingError } from "../sharing/store";
import { canEditChat, chatAccess } from "./access";
import type { Feedback, FeedbackComment, InboxItem } from "./types";

export async function readFeedback(runId: string, actor: string, before?: number): Promise<Feedback> {
  return transaction(async tx=>{
    const chat = await chatAccess(tx,runId,actor);
    const {rows:comments} = await tx.query<FeedbackComment>(`SELECT c.id,c.seq::float8,c.body,u.display_name AS "authorName",c.created_at::text AS "createdAt"
      FROM shared_chat_comments c JOIN users u ON u.id=c.user_id WHERE c.run_id=$1 AND ($2::bigint IS NULL OR c.seq<$2)
      ORDER BY c.seq DESC LIMIT 51`,[runId,before??null]);
    const {rows:[read]} = await tx.query('SELECT last_seq::float8 FROM chat_feedback_reads WHERE run_id=$1 AND user_id=$2',[runId,actor]);
    await chatAccess(tx,runId,actor);
    return {comments:comments.slice(0,50).reverse(),hasMore:comments.length>50,lastRead:read?.last_seq??0,canComment:canEditChat(chat)||['manager','editor','commenter'].includes(chat.guestRole??'')};
  });
}

export async function markFeedbackRead(runId: string, actor: string, seq: unknown) {
  if(typeof seq!=='number'||!Number.isSafeInteger(seq)||seq<0) throw new SharingError("Invalid comment position.",400);
  await transaction(async tx=>{
    await chatAccess(tx,runId,actor,true);
    if(seq>0) {
      const {rows} = await tx.query('SELECT id FROM shared_chat_comments WHERE run_id=$1 AND seq=$2',[runId,seq]);
      if(!rows.length) throw new SharingError("Refresh the conversation before marking feedback read.",409);
    }
    await tx.query(`INSERT INTO chat_feedback_reads(run_id,user_id,last_seq) VALUES($1,$2,$3)
      ON CONFLICT(run_id,user_id) DO UPDATE SET last_seq=GREATEST(chat_feedback_reads.last_seq,EXCLUDED.last_seq)`,[runId,actor,seq]);
  });
  return {read:true};
}

export async function collaborationInbox(actor: string, offset = 0, runId?: string) {
  const items = await query<InboxItem>(`WITH rooms AS MATERIALIZED (
    SELECT session_id AS id FROM session_members WHERE user_id=$1 AND removed_at IS NULL
    UNION SELECT s.id FROM project_members pm JOIN sessions s ON s.project_id=pm.project_id
      WHERE pm.user_id=$1 AND pm.removed_at IS NULL AND s.visibility='public'
    UNION SELECT s.id FROM org_members om JOIN sessions s ON s.org_id=om.org_id
      WHERE om.user_id=$1 AND om.status='active' AND om.role IN ('owner','admin') AND s.visibility='public'
  ), accessible AS MATERIALIZED (
    SELECT r.id,r.session_id,COALESCE(r.title,'Untitled chat') AS title
    FROM rooms s JOIN agent_runs r ON r.session_id=s.id WHERE ($3::uuid IS NULL OR r.id=$3)
      AND room_access_role(r.session_id,$1) IS NOT NULL AND chat_guest_eligible(r.id,$1)
  ) SELECT r.id AS "runId",r.session_id AS "sessionId",r.title,
    (SELECT count(*)::int FROM shared_chat_comments c WHERE c.run_id=r.id AND c.user_id<>$1
      AND c.seq>COALESCE((SELECT last_seq FROM chat_feedback_reads WHERE run_id=r.id AND user_id=$1),0)) AS unread,
    (SELECT count(*)::int FROM chat_reviews v WHERE v.run_id=r.id AND v.reviewer_id=$1 AND v.status='requested') AS reviews
  FROM accessible r WHERE EXISTS (SELECT 1 FROM shared_chat_comments c WHERE c.run_id=r.id AND c.user_id<>$1
      AND c.seq>COALESCE((SELECT last_seq FROM chat_feedback_reads WHERE run_id=r.id AND user_id=$1),0))
    OR EXISTS (SELECT 1 FROM chat_reviews v WHERE v.run_id=r.id AND v.reviewer_id=$1 AND v.status='requested')
  ORDER BY r.title,r.id LIMIT 51 OFFSET $2`,[actor,offset,runId??null]);
  return {items:items.slice(0,50),hasMore:items.length>50};
}
