import { query, queryOne, transaction } from "../db/client";
import type { AgentRunJob } from "../ai/run-events";

export const JOB_LEASE_MS = 60_000;
export const CLAIM_FALLBACK_MS = 20_000;

export async function enqueueLocalJob(job: AgentRunJob, userId: string): Promise<void> {
  await query(`INSERT INTO runner_jobs (run_id, turn_id, user_id, payload) VALUES ($1, $2, $3, $4)
    ON CONFLICT (turn_id) DO NOTHING`, [job.runId, job.turnId, userId, JSON.stringify(job)]);
  await query(`UPDATE agent_runs SET execution = 'local' WHERE id = $1`, [job.runId]);
}

export async function claimNextJob(input: { userId: string; deviceId: string }): Promise<{ job: AgentRunJob; leaseMs: number } | null> {
  return transaction(async tx => {
    const { rows: [row] } = await tx.query<{ payload: AgentRunJob }>(
      `UPDATE runner_jobs SET status = 'claimed', device_id = $2, claimed_at = now(),
        lease_expires_at = now() + make_interval(secs => $3)
       WHERE id = (
         SELECT j.id FROM runner_jobs j JOIN agent_turns t ON t.id = j.turn_id
         JOIN agent_runs r ON r.id = j.run_id JOIN runner_devices d ON d.id = $2
         WHERE j.user_id = $1 AND j.status = 'queued' AND t.status = 'queued'
           AND d.user_id = $1 AND d.revoked_at IS NULL AND d.version = '2'
           AND j.payload->>'agentId' = ANY(d.agent_ids)
           AND runner_supports_model(d.model_catalog, j.payload->>'agentId', j.payload->>'model', j.payload->>'effort')
           AND r.driver_user_id = $1 AND r.control_version = t.control_version
           AND room_access_role(r.session_id, $1) IN ('owner', 'editor')
         ORDER BY j.created_at LIMIT 1 FOR UPDATE OF j SKIP LOCKED
       ) RETURNING payload`, [input.userId, input.deviceId, JOB_LEASE_MS / 1000],
    );
    if (!row) return null;
    await tx.query(`UPDATE agent_turns SET status = 'running' WHERE id = $1`, [row.payload.turnId]);
    await tx.query(`UPDATE agent_runs SET assigned_device_id = $2 WHERE id = $1`, [row.payload.runId, input.deviceId]);
    return { job: row.payload, leaseMs: JOB_LEASE_MS };
  });
}

export async function claimedJob(turnId: string, deviceId: string, allowCompleted = false): Promise<AgentRunJob | null> {
  const row = await queryOne<{ payload: AgentRunJob }>(
    `SELECT j.payload FROM runner_jobs j JOIN agent_turns t ON t.id = j.turn_id
     JOIN agent_runs r ON r.id = j.run_id
     WHERE j.turn_id = $1 AND j.device_id = $2 AND j.status IN ('claimed', 'done')
       AND (j.status = 'claimed' AND t.status = 'running' OR $3 AND j.status = 'done')
       AND (j.lease_expires_at > now() OR t.completion IS NOT NULL OR j.status = 'done')
       AND (t.status = 'completed' OR t.status = 'failed' OR
         (r.driver_user_id = t.driver_user_id AND r.control_version = t.control_version))
       AND room_access_role(r.session_id, j.user_id) IN ('owner', 'editor')`, [turnId, deviceId, allowCompleted],
  );
  return row?.payload ?? null;
}

export async function renewLease(turnId: string, deviceId: string): Promise<void> {
  await query(`UPDATE runner_jobs SET lease_expires_at = now() + make_interval(secs => $3)
    WHERE turn_id = $1 AND device_id = $2 AND status = 'claimed' AND lease_expires_at > now()`,
  [turnId, deviceId, JOB_LEASE_MS / 1000]);
}

export async function completeJob(turnId: string, deviceId: string): Promise<boolean> {
  const row = await queryOne(`UPDATE runner_jobs SET status = 'done'
    WHERE turn_id = $1 AND device_id = $2 AND status IN ('claimed', 'done') RETURNING id`, [turnId, deviceId]);
  return !!row;
}

export async function reclaimForServer(turnId: string): Promise<AgentRunJob | null> {
  const row = await queryOne<{ payload: AgentRunJob }>(`UPDATE runner_jobs SET status = 'failed'
    WHERE turn_id = $1 AND status = 'queued' RETURNING payload`, [turnId]);
  return row?.payload ?? null;
}

export function localRunnersEnabled(): boolean {
  return Boolean(process.env.REDIS_URL) && process.env.LOCAL_RUNNERS !== "0";
}
