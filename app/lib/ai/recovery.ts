import { randomUUID } from "node:crypto";
import { query, transaction } from "../db/client";
import { events } from "../events";
import { notifyUsage } from "../events/notifications";
import { closeTurnInputs } from "./close-inputs";
import { finalizeAgentRun, type FinalizeInput } from "./finalize";
import { publishRunEvent } from "./run-stream";

/** No AI work is replayed. Only an already-persisted completion may be retried. */
async function settleAbandoned(turnId: string, token: string) {
  return transaction(async tx => {
    const { rows: [identity] } = await tx.query(`SELECT run_id FROM agent_turns WHERE id=$1`,[turnId]);
    if (!identity) return null;
    // Same lock order as finalization, handoff and local runner claiming.
    const { rows: [run] } = await tx.query(`SELECT *,room_access_role(session_id,driver_user_id) AS role FROM agent_runs WHERE id=$1 FOR UPDATE`,[identity.run_id]);
    const { rows: [turn] } = await tx.query(`SELECT *,created_at<now()-interval '5 minutes' AS prepare_expired,
      COALESCE(prepared_at,created_at)<now()-interval '15 minutes' AS queue_expired,
      COALESCE(execution_lease_until,created_at+interval '12 minutes')<now() AS server_expired
      FROM agent_turns WHERE id=$1 AND recovery_token=$2 AND status IN ('preparing','queued','running') FOR UPDATE`,[turnId,token]);
    if (!turn || !run) return null;
    const { rows: [job] } = await tx.query(`SELECT *,lease_expires_at<now() AS expired FROM runner_jobs WHERE turn_id=$1 FOR UPDATE`,[turnId]);
    let reason: string | null = null;
    if (!["owner","editor"].includes(run.role) || run.driver_user_id!==turn.driver_user_id || run.control_version!==turn.control_version) {
      reason = "Execution stopped because its access or chat control changed. Saved results remain available for review.";
    } else if (turn.completion) {
      return { completion: turn.completion as FinalizeInput, sessionId: run.session_id as string, runId: run.id as string };
    } else if (turn.status==='preparing' && turn.prepare_expired) {
      reason = "Prompt preparation was interrupted. No automatic retry was made. Review the chat before sending again.";
    } else if (turn.status==='queued' && turn.queue_expired) {
      reason = "No executor accepted this prompt within 15 minutes. Check your connected computer, then send it again.";
    } else if (turn.status==='running' && (turn.execution_target==='local' ? (!job || job.expired || job.status==='failed') : turn.server_expired)) {
      reason = "Connection to the executor was lost. Work may have continued on that machine. Saved activity, checkpoints and candidate commits were preserved; review them before starting another turn.";
    }
    if (!reason) {
      await tx.query(`UPDATE agent_turns SET recovery_token=NULL,recovery_after=now()+interval '30 seconds' WHERE id=$1`,[turnId]);
      return null;
    }
    await closeTurnInputs(tx,turnId);
    await tx.query(`UPDATE agent_turns SET status='failed',ended_at=now(),recovery_token=NULL,recovery_error=NULL,
      result=$2 WHERE id=$1`,[turnId,JSON.stringify({status:'failed',headSha:null,changes:[],error:reason,uncertain:true})]);
    await tx.query(`UPDATE runner_jobs SET status='failed' WHERE turn_id=$1 AND status<>'done'`,[turnId]);
    await tx.query(`UPDATE agent_runs SET status='failed',error=$2,ended_at=now(),control_version=control_version+1
      WHERE id=$1 AND driver_user_id=$3 AND control_version=$4`,[run.id,reason,turn.driver_user_id,turn.control_version]);
    await tx.query(`WITH n AS (UPDATE agent_runs SET message_seq=message_seq+1 WHERE id=$1 RETURNING message_seq)
      INSERT INTO agent_run_messages(run_id,seq,role,body) SELECT $1,message_seq,'system',$2 FROM n`,[run.id,reason]);
    return { completion: null, sessionId: run.session_id as string, runId: run.id as string };
  });
}

export async function recoverAgentTurns(limit = 25): Promise<number> {
  if (!Number.isInteger(limit) || limit<1 || limit>100) throw new Error("Invalid recovery batch size.");
  const token=randomUUID();
  const claimed=await query<{id:string;recovery_attempts:number}>(`UPDATE agent_turns SET recovery_token=$1,
    recovery_after=now()+interval '2 minutes',recovery_attempts=recovery_attempts+1
    WHERE id IN (
      SELECT t.id FROM agent_turns t JOIN agent_runs r ON r.id=t.run_id
      LEFT JOIN runner_jobs j ON j.turn_id=t.id
      WHERE t.status IN ('preparing','queued','running') AND t.recovery_after<=now() AND (
        t.completion IS NOT NULL OR
        room_access_role(r.session_id,t.driver_user_id) IS NULL OR
        room_access_role(r.session_id,t.driver_user_id)='viewer' OR
        r.control_version<>t.control_version OR r.driver_user_id<>t.driver_user_id OR
        t.status='preparing' AND t.created_at<now()-interval '5 minutes' OR
        t.status='queued' AND COALESCE(t.prepared_at,t.created_at)<now()-interval '15 minutes' OR
        t.status='running' AND (
          t.execution_target='local' AND (j.id IS NULL OR j.status='failed' OR j.lease_expires_at<now()) OR
          t.execution_target='server' AND COALESCE(t.execution_lease_until,t.created_at+interval '12 minutes')<now()
        )
      ) ORDER BY t.recovery_after,t.created_at LIMIT $2 FOR UPDATE OF t SKIP LOCKED
    ) RETURNING id,recovery_attempts`,[token,limit]);
  for (const turn of claimed) {
    try {
      const result=await settleAbandoned(turn.id,token);
      if (!result) continue;
      const finalized=result.completion ? await finalizeAgentRun(result.completion) : {status:'failed',headSha:null};
      await query(`UPDATE agent_turns SET recovery_token=NULL,recovery_error=NULL WHERE id=$1 AND recovery_token=$2`,[turn.id,token]);
      await notifyUsage(result.sessionId);
      await events().then(bus=>bus.publish(result.sessionId,{type:'run.control',runId:result.runId,at:Date.now()})).catch(()=>{});
      await publishRunEvent(turn.id,{t:'exit',code:finalized.status==='completed'?0:1,ms:0,
        headSha:finalized.headSha,committed:!!finalized.headSha}).catch(()=>{});
    } catch {
      // Persist bounded, redacted retry state for operators; no transcript/secrets
      // in worker logs. Another worker can take over after the claim deadline.
      const delay=Math.min(300,2**Math.min(turn.recovery_attempts,9));
      await query(`UPDATE agent_turns SET recovery_token=NULL,recovery_after=now()+make_interval(secs=>$3),
        recovery_error='Completion recovery is awaiting retry; candidate data is preserved.' WHERE id=$1 AND recovery_token=$2`,[turn.id,token,delay]);
      console.warn("A saved AI completion is awaiting recovery.");
    }
  }
  return claimed.length;
}
