import { query, transaction } from "../db/client";
import { events } from "../events";
import { ControlError, isUuid } from "./turns";
import type { AgentRunJob } from "./run-events";
import type { InputSource, QueuedInput } from "../../../runner/input-types";
import { randomUUID } from "node:crypto";

export type ChatInput = { id: string; body: string; status: "queued" | "delivering" | "delivered" | "cancelled" | "failed" | "unconfirmed"; error: string | null; createdAt: string };
const columns = 'id,body,status,error,created_at::text AS "createdAt"';

async function notify(sessionId: string, runId: string, userId: string) {
  const bus = await events();
  const event = { type: "run.inputs" as const, runId, at: Date.now() };
  await Promise.all([bus.publish(sessionId,event),bus.publish(`user:${userId}`,event)]).catch(() => {});
}

export async function listChatInputs(runId: string): Promise<ChatInput[]> {
  return query<ChatInput>(`SELECT ${columns} FROM (SELECT * FROM agent_run_inputs WHERE run_id=$1 ORDER BY position DESC LIMIT 100) q ORDER BY position`,[runId]);
}

export async function enqueueChatInput(runId: string, userId: string, input: unknown): Promise<ChatInput> {
  const value = input as { id?: unknown; body?: unknown; controlVersion?: unknown } | null;
  if (!value || !isUuid(value.id) || typeof value.body !== "string" || !value.body.trim() || value.body.length > 32000 || !Number.isInteger(value.controlVersion)) {
    throw new ControlError("Enter a message of 1–32,000 characters with a valid request ID.",400);
  }
  const body = value.body.trim();
  const result = await transaction(async tx => {
    const { rows: [run] } = await tx.query(`SELECT *,room_access_role(session_id,$2) AS role FROM agent_runs WHERE id=$1 FOR UPDATE`,[runId,userId]);
    if (!run || !["owner","editor"].includes(run.role)) throw new ControlError("You no longer have edit access.",403);
    if (run.driver_user_id !== userId || run.control_version !== value.controlVersion) throw new ControlError("Only the current driver can queue messages. Refresh chat control.",409);
    const { rows: [existing] } = await tx.query<ChatInput & { run_id: string; user_id: string }>(`SELECT ${columns},run_id,user_id FROM agent_run_inputs WHERE id=$1`,[value.id]);
    if (existing) {
      if (existing.run_id !== runId || existing.user_id !== userId || existing.body !== body) throw new ControlError("That request ID already belongs to another message.");
      return { entry: existing, sessionId: run.session_id };
    }
    const { rows: [turn] } = await tx.query(`SELECT id,input_closed_at FROM agent_turns WHERE run_id=$1 AND status IN ('preparing','queued','running') ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,[runId]);
    if (!turn || turn.input_closed_at) throw new ControlError("This turn is finishing. Your message was not queued; send it after the response finishes.");
    if (run.execution === "local") {
      const { rows: [device] } = await tx.query(`SELECT supports_inputs FROM runner_devices WHERE id=$1`,[run.assigned_device_id]);
      if (device && !device.supports_inputs) throw new ControlError("Update and restart the desktop runner to queue messages during a task.");
    }
    const { rows: [limit] } = await tx.query(`SELECT count(*)::int AS count,COALESCE(sum(length(body)),0)::int AS bytes FROM agent_run_inputs WHERE turn_id=$1 AND status<>'cancelled'`,[turn.id]);
    if (limit.count >= 50 || limit.bytes + body.length > 256000) throw new ControlError("This turn's message queue is full. Wait for it to finish.",429);
    const { rows: [entry] } = await tx.query<ChatInput>(`INSERT INTO agent_run_inputs(id,run_id,turn_id,user_id,control_version,body) VALUES($1,$2,$3,$4,$5,$6) RETURNING ${columns}`,[value.id,runId,turn.id,userId,value.controlVersion,body]);
    return { entry,sessionId:run.session_id };
  });
  await notify(result.sessionId,runId,userId);
  return result.entry;
}

export async function cancelChatInput(runId: string, userId: string, id: string) {
  if (!isUuid(id)) throw new ControlError("Invalid message ID.",400);
  const result = await transaction(async tx => {
    const { rows: [run] } = await tx.query(`SELECT *,room_access_role(session_id,$2) AS role FROM agent_runs WHERE id=$1 FOR UPDATE`,[runId,userId]);
    if (!run || !["owner","editor"].includes(run.role) || run.driver_user_id!==userId) throw new ControlError("Only the driver can remove a queued message.",403);
    const deleted = await tx.query(`UPDATE agent_run_inputs SET status='cancelled' WHERE id=$1 AND run_id=$2 AND user_id=$3 AND status='queued' RETURNING id`,[id,runId,userId]);
    if (!deleted.rowCount) throw new ControlError("This message has already been claimed or removed.");
    return run.session_id as string;
  });
  await notify(result,runId,userId);
}

/** Shared by local devices and server workers, fenced by turn and driver. */
export async function consumeChatInput(job: AgentRunJob, action: {
  kind: "claim"; claimId: string; closeIfEmpty?: boolean;
} | { kind: "ack" | "uncertain"; id: string; error?: string }): Promise<QueuedInput | null> {
  const result = await transaction(async tx => {
    const { rows: [run] } = await tx.query(`SELECT *,room_access_role(session_id,$2) AS role FROM agent_runs WHERE id=$1 FOR UPDATE`,[job.runId,job.userId]);
    const { rows: [turn] } = await tx.query(`SELECT * FROM agent_turns WHERE id=$1 AND run_id=$2 FOR UPDATE`,[job.turnId,job.runId]);
    if (!run || !turn || run.driver_user_id!==job.userId || run.control_version!==job.controlVersion ||
        turn.driver_user_id!==job.userId || turn.control_version!==job.controlVersion || turn.status!=="running" || turn.completion || !["owner","editor"].includes(run.role)) {
      throw new ControlError("This execution no longer controls the chat.",403);
    }
    if (action.kind === "claim") {
      if (!isUuid(action.claimId)) throw new ControlError("Invalid claim ID.",400);
      const { rows: [retry] } = await tx.query(`SELECT id,body,turn_id,status FROM agent_run_inputs WHERE claim_id=$1`,[action.claimId]);
      if (retry) {
        if (retry.turn_id!==job.turnId) throw new ControlError("Claim belongs to another execution.",403);
        return { entry: retry.status==='delivering'?{id:retry.id,body:retry.body}:null };
      }
      // Only one input in flight, preserving FIFO even with concurrent callers.
      const { rows: [pending] } = await tx.query(`SELECT id,body,status FROM agent_run_inputs WHERE turn_id=$1 AND status IN ('queued','delivering') ORDER BY position LIMIT 1 FOR UPDATE`,[job.turnId]);
      if (pending?.status === "delivering") throw new ControlError("A previous input is awaiting acknowledgement.");
      if (!pending) {
        if (action.closeIfEmpty) await tx.query(`UPDATE agent_turns SET input_closed_at=COALESCE(input_closed_at,now()) WHERE id=$1`,[job.turnId]);
        return { entry: null };
      }
      await tx.query(`UPDATE agent_run_inputs SET status='delivering',claim_id=$2 WHERE id=$1`,[pending.id,action.claimId]);
      return { entry:{id:pending.id,body:pending.body} };
    }
    if (!isUuid(action.id)) throw new ControlError("Invalid message ID.",400);
    const { rows: [entry] } = await tx.query(`SELECT * FROM agent_run_inputs WHERE id=$1 AND turn_id=$2 FOR UPDATE`,[action.id,job.turnId]);
    if (!entry) throw new ControlError("Unknown queued message.",404);
    if (entry.status==='delivered' || entry.status==='unconfirmed') return { entry:null };
    if (entry.status!=='delivering') throw new ControlError("Message was not claimed.");
    if (action.kind==='uncertain') {
      await tx.query(`UPDATE agent_run_inputs SET status='unconfirmed',error=$2 WHERE id=$1`,[entry.id,action.error?.slice(0,500)||"The agent may have received this message. It was not replayed."]);
      return { entry:null };
    }
    const { rows: [message] } = await tx.query(`WITH allocated AS (UPDATE agent_runs SET message_seq=message_seq+1 WHERE id=$1 RETURNING message_seq)
      INSERT INTO agent_run_messages(run_id,seq,role,body,author_user_id) SELECT $1,message_seq,'user',$2,$3 FROM allocated RETURNING id,seq`,[job.runId,entry.body,entry.user_id]);
    await tx.query(`UPDATE agent_run_inputs SET status='delivered',delivered_at=now(),message_id=$2 WHERE id=$1`,[entry.id,message.id]);
    return { entry:null,message:{seq:message.seq,body:entry.body as string} };
  });
  if (action.kind !== "claim" || result.entry) await notify(job.sessionId,job.runId,job.userId);
  if (result.message) await (await events()).publish(job.sessionId,{type:"run.turn",inputId:action.kind === "ack" ? action.id : undefined,runId:job.runId,role:"user",authorName:job.author.name,body:result.message.body,seq:result.message.seq,at:Date.now()}).catch(()=>{});
  return result.entry;
}

export async function serverInputSource(job: AgentRunJob): Promise<InputSource & { close(): Promise<void> }> {
  const listeners = new Set<() => void>();
  const off = await (await events()).subscribe(`user:${job.userId}`,event=>{
    if (event.type==='resync' || event.type==='run.inputs' && event.runId===job.runId) for(const listener of [...listeners])listener();
  });
  return {
    claim: closeIfEmpty=>consumeChatInput(job,{kind:'claim',claimId:randomUUID(),closeIfEmpty}),
    acknowledge: async id=>{await consumeChatInput(job,{kind:'ack',id});},
    uncertain: async(id,error)=>{await consumeChatInput(job,{kind:'uncertain',id,error});},
    subscribe: listener=>{listeners.add(listener);return()=>{listeners.delete(listener);};},
    close: off,
  };
}
