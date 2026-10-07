import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { transaction } from "../db/client";
import { SharingError } from "../sharing/store";
import { canEditChat, chatAccess, currentHead, requireEditor, type ChatAccess } from "./access";
import { briefingFields, type Briefing, type BriefingBody, type BriefingSource } from "./types";

const excerpt = (text: string, length = 900) => text.length > length ? `${text.slice(0,length)}…` : text;
type Saved = { body: BriefingBody; sources: BriefingSource[]; source_fingerprint: string; source_seq: string;
  head_sha: string | null; revision: number; shared_with_guests: boolean; updatedBy: string; updatedAt: string };

/** Extractive drafting: only attributed records, never inferred acceptance or
 * a claim that model output proves a task complete. No model/network under a lock. */
async function draft(tx: PoolClient, chat: ChatAccess): Promise<Briefing> {
  const internal = !!chat.roomRole;
  const {rows:messages} = await tx.query<{id:string;role:string;body:string;seq:number}>(`SELECT id,role,left(body,4000) AS body,seq::int
    FROM agent_run_messages WHERE run_id=$1 AND role IN ('user','agent')
    AND (id=(SELECT id FROM agent_run_messages WHERE run_id=$1 AND role='user' ORDER BY seq LIMIT 1)
      OR id IN (SELECT id FROM agent_run_messages WHERE run_id=$1 AND role IN ('user','agent') ORDER BY seq DESC LIMIT 8)) ORDER BY seq`,[chat.id]);
  const sources: BriefingSource[] = messages.map(m=>({kind:"message",id:m.id,label:`${m.role==='user'?'Human':'AI'} message ${m.seq}`,excerpt:excerpt(m.body)}));
  const first = messages.find(m=>m.role==='user'), lastHuman = messages.findLast(m=>m.role==='user'), lastAI = messages.findLast(m=>m.role==='agent');
  let decisions = "No approved decisions recorded for this conversation.";
  let progress = lastAI ? `Latest AI report — verify before relying on it:\n${excerpt(lastAI.body)}` : "No AI progress recorded yet.";
  let nextAction = lastHuman && lastHuman.id!==first?.id ? `Latest request — confirm whether it still needs work:\n${excerpt(lastHuman.body)}` : "Agree on the next action with the host.";
  const headSha = internal ? await currentHead(tx,chat) : null;
  let blockers = "No blocker has been explicitly confirmed. Check with the host.";
  if (internal) {
    const {rows:memories} = await tx.query<{id:string;text:string;revision:number}>(`SELECT m.id,left(m.text,900) AS text,m.revision FROM memory_records m
      LEFT JOIN agent_run_messages am ON am.id=m.source_agent_message_id
      LEFT JOIN session_messages sm ON sm.id=m.source_message_id
      WHERE m.source_run_id=$1 AND m.kind='fact' AND m.status='approved' AND m.valid_to IS NULL AND m.valid_from<=now()
        AND (NOT m.publish_gated OR m.published_at IS NOT NULL)
        AND (m.source_agent_message_id IS NULL OR m.source_hash=md5(am.body))
        AND (m.source_message_id IS NULL OR (sm.deleted_at IS NULL AND m.source_hash=md5(sm.body)))
      ORDER BY m.stated_at DESC,m.id LIMIT 8`,[chat.id]);
    if(memories.length) decisions = excerpt(memories.map(m=>m.text).join("\n\n"),5900);
    sources.push(...memories.map(m=>({kind:"memory" as const,id:m.id,label:`Approved decision · revision ${m.revision}`,excerpt:m.text})));
    const {rows:turns} = await tx.query<{id:string;sha:string|null}>(`SELECT id,result->>'headSha' AS sha FROM agent_turns
      WHERE run_id=$1 AND status='completed' ORDER BY created_at DESC,id DESC LIMIT 5`,[chat.id]);
    const commits = turns.filter(t=>t.sha && /^[0-9a-f]{40,64}$/.test(t.sha));
    if(commits.length) progress = `Recorded saved changes: ${commits.map(t=>t.sha!.slice(0,8)).join(', ')}. Saving is not a review or test result.\n\n${progress}`;
    sources.push(...commits.map(t=>({kind:"commit" as const,id:t.sha!,label:"Completed turn checkpoint",excerpt:`Saved by turn ${t.id}`})));
    const {rows:tasks} = await tx.query<{id:string;body:string;status:string}>(`SELECT id,left(body,500) AS body,status FROM room_tasks
      WHERE run_id=$1 AND status<>'cancelled' ORDER BY created_at DESC,id DESC LIMIT 8`,[chat.id]);
    const pending = tasks.filter(t=>t.status!=='done');
    if(pending.length) nextAction = pending.map(t=>`${t.status==='in_progress'?'In progress':'To do'}: ${t.body}`).join('\n');
    const done = tasks.filter(t=>t.status==='done');
    if(done.length) progress += `\n\nTasks marked done:\n${done.map(t=>t.body).join('\n')}`;
    sources.push(...tasks.map(t=>({kind:"task" as const,id:t.id,label:`Task · ${t.status}`,excerpt:t.body})));
    if(['failed','cancelled'].includes(chat.status)) blockers = `The latest run is ${chat.status}. Inspect its outcome before continuing.`;
    else if(['running','queued'].includes(chat.status)) blockers = "AI work is still in progress. Wait for a saved checkpoint before handing off or approving changes.";
  }
  const body: BriefingBody = {goal:first ? excerpt(first.body) : "The goal has not been recorded yet.",decisions,progress,blockers,nextAction};
  const fingerprint = createHash('sha256').update(JSON.stringify({body,sources,headSha,seq:chat.seq,status:internal?chat.status:null})).digest('hex');
  return {body,sources,fingerprint,sourceSeq:Number(chat.seq),headSha,revision:0,sharedWithGuests:false,stale:false,canEdit:canEditChat(chat),canPublish:chat.guestRole==='manager',updatedBy:null,updatedAt:null};
}

export async function readBriefing(runId: string, actor: string, regenerate = false): Promise<Briefing> {
  return transaction(async tx=>{
    const chat = await chatAccess(tx,runId,actor);
    if(regenerate) requireEditor(chat);
    const generated = await draft(tx,chat);
    const {rows:[saved]} = await tx.query<Saved>(`SELECT b.*,u.display_name AS "updatedBy",b.updated_at::text AS "updatedAt"
      FROM chat_briefings b JOIN users u ON u.id=b.updated_by WHERE run_id=$1`,[runId]);
    const current = await chatAccess(tx,runId,actor);
    if(chat.roomRole&&!current.roomRole) throw new SharingError("Workspace access changed. Reload the conversation.");
    if(!saved || (!chat.roomRole&&!saved.shared_with_guests)) return generated;
    if(regenerate) return {...generated,revision:saved.revision,sharedWithGuests:saved.shared_with_guests};
    // Compare published evidence on the server, without returning any newly
    // added internal evidence to a guest until the host explicitly republishes.
    const latestFingerprint = chat.roomRole ? generated.fingerprint : (await draft(tx,{...chat,roomRole:'viewer'})).fingerprint;
    await chatAccess(tx,runId,actor);
    return {...generated,body:saved.body,sources:saved.sources,fingerprint:saved.source_fingerprint,
      sourceSeq:Number(saved.source_seq),headSha:saved.head_sha,revision:saved.revision,
      sharedWithGuests:saved.shared_with_guests,updatedAt:saved.updatedAt,updatedBy:saved.updatedBy,
      canEdit:generated.canEdit&&(!saved.shared_with_guests||generated.canPublish),
      stale: latestFingerprint!==saved.source_fingerprint};
  });
}

export async function saveBriefing(runId: string, actor: string, input: unknown) {
  const value = input as {body?:BriefingBody;revision?:number;fingerprint?:string;sharedWithGuests?:boolean}|null;
  if(!value?.body || !Number.isSafeInteger(value.revision) || value.revision!<0 || typeof value.fingerprint!=='string' || typeof value.sharedWithGuests!=='boolean'
    || briefingFields.some(field=>typeof value.body?.[field]!=='string' || !value.body[field].trim() || value.body[field].length>6000)) {
    throw new SharingError("Complete each briefing section using at most 6,000 characters.",400);
  }
  await transaction(async tx=>{
    const chat = await chatAccess(tx,runId,actor,true); requireEditor(chat);
    const generated = await draft(tx,chat);
    const {rows:[saved]} = await tx.query<Saved>('SELECT * FROM chat_briefings WHERE run_id=$1',[runId]);
    if((saved?.revision??0)!==value.revision) throw new SharingError("Someone updated this briefing. Your draft is retained; reload the latest briefing before saving.",409);
    if(generated.fingerprint!==value.fingerprint) throw new SharingError("The source conversation or saved work changed. Your draft is retained; refresh the sources before saving.",409);
    // Publishing internal evidence to guests requires the same authority as invitations.
    if(value.sharedWithGuests || saved?.shared_with_guests) {
      const {rows:[manager]} = await tx.query('SELECT chat_share_manager($1,$2) AS allowed',[runId,actor]);
      if(!manager.allowed) throw new SharingError("Only the chat host can publish or update a briefing shared with guests.");
    }
    const body = Object.fromEntries(briefingFields.map(field=>[field,value.body![field].trim()]));
    await tx.query(`INSERT INTO chat_briefings(run_id,body,sources,source_fingerprint,source_seq,head_sha,shared_with_guests,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(run_id) DO UPDATE SET body=EXCLUDED.body,sources=EXCLUDED.sources,
        source_fingerprint=EXCLUDED.source_fingerprint,source_seq=EXCLUDED.source_seq,head_sha=EXCLUDED.head_sha,
        shared_with_guests=EXCLUDED.shared_with_guests,updated_by=EXCLUDED.updated_by,updated_at=now(),revision=chat_briefings.revision+1`,
      [runId,JSON.stringify(body),JSON.stringify(generated.sources),generated.fingerprint,generated.sourceSeq,generated.headSha,value.sharedWithGuests,actor]);
  });
  return readBriefing(runId,actor);
}
