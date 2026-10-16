import { notifyUsage } from "../events/notifications";
import { closeTurnInputs } from "./close-inputs";
import { transaction } from "../db/client";
import type { AgentRunJob } from "./run-events";

export class ControlError extends Error {
  constructor(message: string, public status = 409) { super(message); }
}

export const isUuid = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

/**
 * Atomically admit one execution turn.
 *
 * Every turn runs on the member's own computer, with that person's machine and
 * AI account, as in a desktop orchestrator, so nothing caps how many run at
 * once: the person starting them is the limit. Period quotas and the
 * one-shared-chat-per-room rule apply to every turn.
 */
export async function reserveTurn(runId: string, userId: string, turnId: string, version: number) {
  return transaction(async (tx) => {
    const { rows: [run] } = await tx.query(
      `SELECT *, room_access_role(session_id, $2) AS role FROM agent_runs WHERE id = $1 FOR UPDATE`,
      [runId, userId],
    );
    if (!run || !["owner", "editor"].includes(run.role)) throw new ControlError("You no longer have edit access.", 403);
    if (run.driver_user_id !== userId || run.control_version !== version) {
      throw new ControlError("Control changed. Refresh the chat before continuing.");
    }
    const { rows: [room] } = await tx.query(`SELECT org_id, project_id FROM sessions WHERE id = $1`, [run.session_id]);
    await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [room.org_id ?? `${run.session_id}:${userId}`]);
    // Shared chats in one room race for the same room head, so a person runs
    // one at a time there: a correctness rule, not a capacity cap. Parallel
    // chats have branches of their own and are the way to run several at once.
    const { rows: [quota] } = await tx.query(
      `SELECT
        (SELECT count(*)::int FROM agent_runs WHERE session_id = $1 AND driver_user_id = $2 AND status = 'running' AND isolation = 'shared') AS personal,
        (SELECT run_monthly_quota FROM orgs WHERE id = $3) AS monthly_limit,
        (SELECT run_hourly_limit FROM projects WHERE id = $4) AS hourly_limit,
        (SELECT count(*)::int FROM agent_turns t JOIN agent_runs r ON r.id = t.run_id
          JOIN sessions s ON s.id = r.session_id
          WHERE s.org_id = $3 AND t.created_at >= date_trunc('month', now())) AS monthly_used,
        (SELECT count(*)::int FROM agent_turns t JOIN agent_runs r ON r.id = t.run_id
          JOIN sessions s ON s.id = r.session_id
          WHERE s.project_id = $4 AND t.created_at >= now() - interval '1 hour') AS hourly_used`,
      [run.session_id, userId, room.org_id, room.project_id],
    );
    if (run.isolation !== "isolated" && quota.personal > 0) {
      throw new ControlError("Your chat in this room is still working. Wait for it to finish, or start a parallel chat.", 429);
    }
    // Check and reserve under the same org lock. Every accepted execution turn
    // counts, including continuations of an existing conversation.
    if (quota.hourly_limit != null && quota.hourly_used >= quota.hourly_limit) {
      throw new ControlError("This project has reached its hourly AI turn limit. Try again later.", 429);
    }
    if (quota.monthly_limit != null && quota.monthly_used >= quota.monthly_limit) {
      throw new ControlError("Your organisation has reached its monthly AI turn limit.", 429);
    }
    const { rows: [existing] } = await tx.query(`SELECT id FROM agent_turns WHERE id = $1`, [turnId]);
    if (existing) throw new ControlError("This prompt has already been submitted. Reload the chat to see its result.");
    if (run.status === "running" || run.status === "queued") throw new ControlError("Wait for the current turn to finish.");
    await tx.query(
      `INSERT INTO agent_turns(id, run_id, driver_user_id, control_version, execution_target) VALUES ($1, $2, $3, $4, 'local')`,
      [turnId, runId, userId, version],
    );
    await tx.query(`UPDATE agent_runs SET status = 'running', ended_at = NULL, started_at = now() WHERE id = $1`, [runId]);
  });
}

/**
 * Hand a reserved turn to the member's computer. Every turn runs there: the
 * runner job is created in the same transaction, so a web crash before the
 * notification cannot strand a turn without one. This server never runs it.
 */
export async function prepareTurn(job: AgentRunJob) {
  await transaction(async tx => {
    await tx.query(`SELECT id FROM agent_runs WHERE id = $1 FOR UPDATE`, [job.runId]);
    const prepared = await tx.query(`UPDATE agent_turns SET payload=$2,status='queued',prepared_at=now(),execution_target='local'
      WHERE id=$1 AND status='preparing' RETURNING id`, [job.turnId, JSON.stringify(job)]);
    if (!prepared.rowCount) throw new ControlError("This turn is no longer waiting for preparation. Refresh the chat.");
    await tx.query(`INSERT INTO runner_jobs(run_id,turn_id,user_id,payload) VALUES ($1,$2,$3,$4)
      ON CONFLICT(turn_id) DO NOTHING`, [job.runId,job.turnId,job.userId,JSON.stringify(job)]);
    await tx.query(`UPDATE agent_runs SET execution='local' WHERE id=$1`,[job.runId]);
    await tx.query(`UPDATE agent_runs SET agent_id = $2 WHERE id = $1 AND control_version = $3 AND driver_user_id = $4`,
      [job.runId, job.agentId, job.controlVersion, job.userId]);
    if (job.restoreCheckpoint) await tx.query(`UPDATE agent_runs SET restore_snapshot_id = NULL WHERE id = $1 AND restore_snapshot_id = $2`, [job.runId, job.restoreCheckpoint.id]);
  });
}

export async function failTurn(turnId: string, message: string) {
  let sessionId: string | undefined;
  await transaction(async (tx) => {
    const { rows: [turn] } = await tx.query(`SELECT run_id FROM agent_turns WHERE id = $1`, [turnId]);
    if (!turn) return;
    const { rows: [run] } = await tx.query(`SELECT id,session_id FROM agent_runs WHERE id = $1 FOR UPDATE`, [turn.run_id]);
    sessionId = run?.session_id;
    const result = await tx.query(
      `UPDATE agent_turns SET status = 'failed', ended_at = now(), result = $2
       WHERE id = $1 AND status IN ('preparing', 'queued', 'running') AND completion IS NULL RETURNING id`,
      [turnId, JSON.stringify({ error: message })],
    );
    if (result.rowCount) await closeTurnInputs(tx, turnId);
    if (result.rowCount) await tx.query(
      `UPDATE agent_runs SET status = 'failed', error = $2, ended_at = now() WHERE id = $1`, [turn.run_id, message],
    );
  });
  if (sessionId) void notifyUsage(sessionId);
}
