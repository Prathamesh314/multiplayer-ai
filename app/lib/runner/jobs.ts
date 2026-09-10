/*
 * The runner job queue's operations: enqueue, claim, lease, complete, reclaim.
 *
 * Correctness lives in three SQL shapes:
 *
 * - **Claim** is one UPDATE over a `FOR UPDATE SKIP LOCKED` pick, so any
 *   number of a user's devices polling concurrently get exactly one winner
 *   per job, without ever blocking each other.
 * - **Reclaim** (the cloud fallback taking back a job no device collected)
 *   only fires on `status = 'queued'` — it can never yank a job a runner has
 *   already started working on.
 * - Every runner-facing operation is keyed by `(run_id, device_id)`, so a
 *   device can only ever touch jobs it claimed itself.
 */

import { query, queryOne } from "../db/client";
import type { AgentRunJob } from "../ai/run-events";

/** How long a claim lives without renewal before the job counts as abandoned. */
export const JOB_LEASE_MS = 60_000;
/** How long the run route waits for a device before falling back to the cloud. */
export const CLAIM_FALLBACK_MS = 20_000;

/** Queue a run for the user's own devices; marks the run as locally executed. */
export async function enqueueLocalJob(job: AgentRunJob, userId: string): Promise<void> {
  await query(
    `INSERT INTO runner_jobs (run_id, user_id, payload) VALUES ($1, $2, $3)`,
    [job.runId, userId, JSON.stringify(job)],
  );
  await query(`UPDATE agent_runs SET execution = 'local' WHERE id = $1`, [job.runId]);
}

/**
 * Claim the oldest queued job for this user, if any. Atomic under concurrency:
 * the inner SELECT locks the row, SKIP LOCKED steps around a sibling device's
 * in-flight claim, and the UPDATE flips it in the same statement.
 */
export async function claimNextJob(input: {
  userId: string;
  deviceId: string;
}): Promise<{ job: AgentRunJob; leaseMs: number } | null> {
  const row = await queryOne<{ payload: AgentRunJob }>(
    `UPDATE runner_jobs SET
        status = 'claimed',
        device_id = $2,
        claimed_at = now(),
        lease_expires_at = now() + make_interval(secs => $3)
      WHERE run_id = (
        SELECT run_id FROM runner_jobs
         WHERE user_id = $1 AND status = 'queued'
         ORDER BY created_at
         LIMIT 1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING payload`,
    [input.userId, input.deviceId, JOB_LEASE_MS / 1000],
  );
  if (!row) return null;

  await query(
    `UPDATE agent_runs SET assigned_device_id = $2,
            lease_expires_at = now() + make_interval(secs => $3)
      WHERE id = $1`,
    [row.payload.runId, input.deviceId, JOB_LEASE_MS / 1000],
  );
  return { job: row.payload, leaseMs: JOB_LEASE_MS };
}

/** The job this device has claimed for this run, or null — the authz check
 * behind the events and complete endpoints. */
export async function claimedJob(runId: string, deviceId: string): Promise<AgentRunJob | null> {
  const row = await queryOne<{ payload: AgentRunJob }>(
    `SELECT payload FROM runner_jobs
      WHERE run_id = $1 AND device_id = $2 AND status = 'claimed'`,
    [runId, deviceId],
  );
  return row?.payload ?? null;
}

/** Keep an in-progress claim alive; called as event batches arrive. */
export async function renewLease(runId: string, deviceId: string): Promise<void> {
  await query(
    `UPDATE runner_jobs SET lease_expires_at = now() + make_interval(secs => $3)
      WHERE run_id = $1 AND device_id = $2 AND status = 'claimed'`,
    [runId, deviceId, JOB_LEASE_MS / 1000],
  );
}

/** Close the job out after a verified completion report. */
export async function completeJob(runId: string, deviceId: string): Promise<boolean> {
  const row = await queryOne<{ run_id: string }>(
    `UPDATE runner_jobs SET status = 'done'
      WHERE run_id = $1 AND device_id = $2 AND status = 'claimed'
      RETURNING run_id`,
    [runId, deviceId],
  );
  return row !== null;
}

/**
 * The cloud fallback: take back a job no device collected. Returns the
 * payload only when the job was still queued — a claimed job stays with its
 * runner, and the caller learns nothing happened.
 */
export async function reclaimForServer(runId: string): Promise<AgentRunJob | null> {
  const row = await queryOne<{ payload: AgentRunJob }>(
    `UPDATE runner_jobs SET status = 'reclaimed'
      WHERE run_id = $1 AND status = 'queued'
      RETURNING payload`,
    [runId],
  );
  if (!row) return null;
  await query(`UPDATE agent_runs SET execution = 'server' WHERE id = $1`, [runId]);
  return row.payload;
}

/** Is local-first routing on? Requires Redis: the event bridge between the
 * runner's up-stream and the driver's browser stream rides the per-run
 * channel, which is Redis pub/sub. Opt out with LOCAL_RUNNERS=0. */
export function localRunnersEnabled(): boolean {
  return Boolean(process.env.REDIS_URL) && process.env.LOCAL_RUNNERS !== "0";
}
