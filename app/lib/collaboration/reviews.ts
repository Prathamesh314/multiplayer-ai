import { transaction } from "../db/client";
import { isUuid } from "../ai/turns";
import { SharingError } from "../sharing/store";
import { chatAccess, currentHead, requireEditor } from "./access";
import type { ChatReview } from "./types";

export async function listReviews(runId: string, actor: string, offset = 0) {
  if(!Number.isSafeInteger(offset)||offset<0||offset>10000)throw new SharingError("Invalid review page.",400);
  return transaction(async tx=>{
    const chat = await chatAccess(tx,runId,actor);
    if(!chat.roomRole) throw new SharingError("Code reviews require workspace access.");
    const head = await currentHead(tx,chat);
    const {rows:reviews} = await tx.query<ChatReview>(`SELECT v.id,v.run_id AS "runId",v.reviewer_id AS "reviewerId",u.display_name AS "reviewerName",
      v.requested_by AS "requestedBy",c.display_name AS "requesterName",v.head_sha AS "headSha",v.base_sha AS "baseSha",v.status,
      v.request_note AS "requestNote",v.response_note AS "responseNote",v.created_at::text AS "createdAt",v.resolved_at::text AS "resolvedAt",
      v.head_sha IS DISTINCT FROM $2 AS stale FROM chat_reviews v JOIN users u ON u.id=v.reviewer_id JOIN users c ON c.id=v.requested_by
      WHERE v.run_id=$1 ORDER BY (v.status='requested') DESC,v.created_at DESC,v.id DESC LIMIT 51 OFFSET $3`,[runId,head,offset]);
    const {rows:reviewers} = await tx.query<{id:string;name:string}>(`WITH candidates AS (
      SELECT user_id FROM session_members WHERE session_id=$1 AND removed_at IS NULL
      UNION SELECT user_id FROM project_members WHERE project_id=$3 AND removed_at IS NULL
      UNION SELECT user_id FROM org_members WHERE org_id=$4 AND role IN ('owner','admin') AND status='active'
    ) SELECT u.id,u.display_name AS name FROM candidates c JOIN users u ON u.id=c.user_id
      WHERE u.id<>$2 AND room_access_role($1,u.id) IN ('owner','editor') AND chat_guest_eligible($5,u.id) ORDER BY u.display_name,u.id LIMIT 200`,[chat.sessionId,actor,chat.projectId,chat.orgId,runId]);
    if(!(await chatAccess(tx,runId,actor)).roomRole) throw new SharingError("Workspace access changed. Refresh before reviewing.");
    return {reviews:reviews.slice(0,50),hasMore:reviews.length>50,headSha:head,reviewers,canRequest:['owner','editor'].includes(chat.roomRole)};
  });
}

export async function requestReview(runId: string, actor: string, input: unknown) {
  const value = input as {id?:unknown;reviewerId?:unknown;headSha?:unknown;note?:unknown}|null;
  if(!isUuid(value?.id) || !isUuid(value?.reviewerId) || value.reviewerId.toLowerCase()===actor.toLowerCase()
    || typeof value.headSha!=='string' || typeof value.note!=='string' || value.note.length>4000) throw new SharingError("Choose another workspace editor and enter a review note of at most 4,000 characters.",400);
  return transaction(async tx=>{
    const chat = await chatAccess(tx,runId,actor,true); requireEditor(chat);
    const reviewer = await chatAccess(tx,runId,value.reviewerId as string); requireEditor(reviewer);
    const head = await currentHead(tx,chat,true);
    if(!head || head!==value.headSha || ['running','queued'].includes(chat.status)) throw new SharingError("Wait for AI work to finish and refresh the saved changes before requesting review.",409);
    const {rows:[existing]} = await tx.query('SELECT * FROM chat_reviews WHERE id=$1',[value.id]);
    if(existing) {
      if(existing.run_id===runId && existing.requested_by===actor && existing.reviewer_id===value.reviewerId && existing.head_sha===head && existing.request_note===value.note) return {id:existing.id};
      throw new SharingError("This review request was already used. Start a new request.",409);
    }
    const {rows:[pending]} = await tx.query("SELECT id,requested_by,request_note FROM chat_reviews WHERE run_id=$1 AND reviewer_id=$2 AND head_sha=$3 AND status='requested'",[runId,value.reviewerId,head]);
    if(pending) {
      if(pending.requested_by===actor&&pending.request_note===value.note)return {id:pending.id};
      throw new SharingError("This teammate already has a pending review for this version. Check the existing request; its requester can cancel it before creating a replacement.",409);
    }
    await tx.query(`INSERT INTO chat_reviews(id,run_id,requested_by,reviewer_id,head_sha,base_sha,request_note)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,[value.id,runId,actor,value.reviewerId,head,chat.baseSha,value.note]);
    return {id:value.id};
  });
}

export async function resolveReview(runId: string, actor: string, input: unknown) {
  const value = input as {id?:unknown;status?:unknown;headSha?:unknown;note?:unknown}|null;
  if(!isUuid(value?.id) || !['approved','changes_requested','cancelled'].includes(String(value.status))
    || typeof value.note!=='string' || value.note.length>4000 || (value.status==='changes_requested'&&!value.note.trim())) throw new SharingError("Choose a review outcome. Explain any changes you request.",400);
  return transaction(async tx=>{
    const chat = await chatAccess(tx,runId,actor,true); requireEditor(chat);
    const {rows:[review]} = await tx.query('SELECT * FROM chat_reviews WHERE id=$1 AND run_id=$2 FOR UPDATE',[value.id,runId]);
    if(!review || (value.status==='cancelled' ? review.requested_by!==actor : review.reviewer_id!==actor)) throw new SharingError("Only the assigned reviewer can submit a review; only its requester can cancel it.");
    if(review.status!=='requested') {
      if(review.status===value.status && review.response_note===value.note) return {id:review.id};
      throw new SharingError("This review has already been resolved. Refresh to see the outcome.",409);
    }
    if(value.status!=='cancelled') {
      const head = await currentHead(tx,chat,true);
      if(head!==review.head_sha || value.headSha!==head || ['running','queued'].includes(chat.status)) throw new SharingError("The saved version changed or AI is still working. Ask for a review of the latest version.",409);
    }
    await tx.query('UPDATE chat_reviews SET status=$2,response_note=$3,resolved_at=now() WHERE id=$1',[review.id,value.status,value.note]);
    return {id:review.id};
  });
}
