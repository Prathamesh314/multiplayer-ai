import { queryOne, transaction } from "../db/client";
import type { AgentRunJob } from "./run-events";

export class ControlError extends Error {
  constructor(message: string, public status = 409) { super(message); }
}

export const isUuid = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

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
    const { rows: [quota] } = await tx.query(
      `SELECT
        (SELECT count(*)::int FROM agent_runs WHERE session_id = $1 AND driver_user_id = $2 AND status = 'running') AS personal,
        (SELECT count(*)::int FROM agent_runs r JOIN sessions s ON s.id = r.session_id WHERE s.org_id = $3 AND r.status = 'running') AS org_running,
        (SELECT count(*)::int FROM agent_runs r JOIN sessions s ON s.id = r.session_id WHERE s.project_id = $4 AND r.status = 'running') AS project_running,
        (SELECT run_concurrency_limit FROM orgs WHERE id = $3) AS org_limit,
        (SELECT run_concurrency_limit FROM projects WHERE id = $4) AS project_limit`, [run.session_id, userId, room.org_id, room.project_id],
    );
    if (quota.personal > 0 || (quota.org_limit != null && quota.org_running >= quota.org_limit) ||
        (quota.project_limit != null && quota.project_running >= quota.project_limit)) {
      throw new ControlError("The execution limit is reached. Wait for the active turn to finish.", 429);
    }
    const { rows: [existing] } = await tx.query(`SELECT id FROM agent_turns WHERE id = $1`, [turnId]);
    if (existing) throw new ControlError("This prompt has already been submitted. Reload the chat to see its result.");
    if (run.status === "running" || run.status === "queued") throw new ControlError("Wait for the current turn to finish.");
    await tx.query(
      `INSERT INTO agent_turns(id, run_id, driver_user_id, control_version) VALUES ($1, $2, $3, $4)`,
      [turnId, runId, userId, version],
    );
    await tx.query(`UPDATE agent_runs SET status = 'running', ended_at = NULL, started_at = now() WHERE id = $1`, [runId]);
  });
}

export async function prepareTurn(job: AgentRunJob) {
  await transaction(async tx => {
    await tx.query(`SELECT id FROM agent_runs WHERE id = $1 FOR UPDATE`, [job.runId]);
    await tx.query(`UPDATE agent_turns SET payload = $2, status = 'queued' WHERE id = $1 AND status = 'preparing'`, [job.turnId, JSON.stringify(job)]);
    await tx.query(`UPDATE agent_runs SET agent_id = $2 WHERE id = $1 AND control_version = $3 AND driver_user_id = $4`,
      [job.runId, job.agentId, job.controlVersion, job.userId]);
    if (job.restoreCheckpoint) await tx.query(`UPDATE agent_runs SET restore_snapshot_id = NULL WHERE id = $1 AND restore_snapshot_id = $2`, [job.runId, job.restoreCheckpoint.id]);
  });
}

export async function startTurn(job: AgentRunJob): Promise<boolean> {
  const row = await queryOne(
    `UPDATE agent_turns t SET status = 'running' FROM agent_runs r
     WHERE t.id = $1 AND t.run_id = r.id AND t.status = 'queued'
       AND r.driver_user_id = t.driver_user_id AND r.control_version = t.control_version
       AND room_access_role(r.session_id, t.driver_user_id) IN ('owner', 'editor') RETURNING t.id`,
    [job.turnId],
  );
  return !!row;
}

export async function failTurn(turnId: string, message: string) {
  await transaction(async (tx) => {
    const { rows: [turn] } = await tx.query(`SELECT run_id FROM agent_turns WHERE id = $1`, [turnId]);
    if (!turn) return;
    await tx.query(`SELECT id FROM agent_runs WHERE id = $1 FOR UPDATE`, [turn.run_id]);
    const result = await tx.query(
      `UPDATE agent_turns SET status = 'failed', ended_at = now(), result = $2
       WHERE id = $1 AND status IN ('preparing', 'queued', 'running') AND completion IS NULL RETURNING id`,
      [turnId, JSON.stringify({ error: message })],
    );
    if (result.rowCount) await tx.query(
      `UPDATE agent_runs SET status = 'failed', error = $2, ended_at = now() WHERE id = $1`, [turn.run_id, message],
    );
  });
}
