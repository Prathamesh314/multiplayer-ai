import { transaction } from "../db/client";
import { events } from "../events";
import { notifyUsage } from "../events/notifications";
import { closeTurnInputs } from "./close-inputs";
import { publishRunEvent } from "./run-stream";
import { appendMessage } from "./runs";
import { ControlError } from "./turns";

/**
 * Stop the turn a chat is running. Only its driver can. A turn its computer has
 * not picked up yet ends here and now; a running one is stopped by that
 * computer's runner (told on its own channel, and again when it renews its
 * lease), and finalization keeps what the agent wrote and changed so far.
 */
export async function requestStop(runId: string, userId: string): Promise<{ status: "stopping" | "stopped" }> {
  const plan = await transaction(async tx => {
    const { rows: [run] } = await tx.query(`SELECT *,room_access_role(session_id,$2) AS role FROM agent_runs WHERE id=$1 FOR UPDATE`, [runId, userId]);
    if (!run || !["owner", "editor"].includes(run.role)) throw new ControlError("You no longer have edit access.", 403);
    if (run.driver_user_id !== userId) throw new ControlError("Only the person running this chat can stop it.", 403);
    const { rows: [turn] } = await tx.query(`SELECT id,status FROM agent_turns WHERE run_id=$1 AND status IN ('preparing','queued','running') ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [runId]);
    if (!turn) throw new ControlError("Nothing is running in this chat.", 409);
    const { rows: [job] } = await tx.query(`SELECT j.status,j.device_id,d.supports_stop FROM runner_jobs j LEFT JOIN runner_devices d ON d.id=j.device_id WHERE j.turn_id=$1 FOR UPDATE OF j`, [turn.id]);
    if (job?.status === "claimed" && !job.supports_stop) {
      throw new ControlError("This computer’s Multicode AI app or runner is too old to stop a task. Update it, or wait for the task to finish.", 409);
    }
    await tx.query(`UPDATE agent_turns SET stop_requested_at = COALESCE(stop_requested_at, now()) WHERE id=$1`, [turn.id]);
    if (job?.status === "claimed") return { sessionId: run.session_id as string, turnId: turn.id as string, deviceId: job.device_id as string, now: false };
    // Not picked up by a computer yet: nothing to interrupt.
    await tx.query(`UPDATE runner_jobs SET status='failed' WHERE turn_id=$1 AND status='queued'`, [turn.id]);
    await tx.query(`UPDATE agent_turns SET status='cancelled', ended_at=now(), result=$2 WHERE id=$1`, [turn.id, JSON.stringify({ stopped: true })]);
    await closeTurnInputs(tx, turn.id);
    await tx.query(`UPDATE agent_runs SET status='completed', error=NULL, ended_at=now() WHERE id=$1`, [runId]);
    return { sessionId: run.session_id as string, turnId: turn.id as string, deviceId: null, now: true };
  });
  const bus = await events();
  if (!plan.now) {
    await bus.publish(`device:${plan.deviceId}`, { type: "run.stop", turnId: plan.turnId, at: Date.now() }).catch(() => {});
    await publishRunEvent(plan.turnId, { t: "notice", message: "Stopping…" }).catch(() => {});
    return { status: "stopping" };
  }
  const message = await appendMessage({ runId, role: "system", body: "Stopped before it started." }).catch(() => null);
  if (message) await bus.publish(plan.sessionId, { type: "run.turn", runId, seq: message.seq, role: "system", authorName: null, body: message.body, at: Date.now() }).catch(() => {});
  await publishRunEvent(plan.turnId, { t: "exit", code: 0, ms: 0, headSha: null, committed: false }).catch(() => {});
  await bus.publish(plan.sessionId, { type: "run.finished", runId, status: "completed", headSha: null, at: Date.now() }).catch(() => {});
  void notifyUsage(plan.sessionId);
  return { status: "stopped" };
}
