import { closeTurnInputs } from "./close-inputs";
import { query, transaction } from "../db/client";
import { ControlError } from "./turns";

export type Handoff = {
  id: string;
  fromUserId: string;
  fromName: string;
  toUserId: string | null;
  toName: string | null;
  acceptedBy: string | null;
  acceptedName: string | null;
  note: string;
  status: "pending" | "accepted" | "declined" | "cancelled" | "expired";
  expiresAt: string;
  checkpointSha: string | null;
};

export type HandoffState = {
  offers: Handoff[];
  recipients: { id: string; name: string }[];
};

export async function handoffState(runId: string, sessionId: string): Promise<HandoffState> {
  await query(`UPDATE run_handoffs SET status = 'expired', resolved_at = now()
    WHERE run_id = $1 AND status = 'pending' AND expires_at <= now()`, [runId]);
  const offers = await query<Handoff>(
    `SELECT h.id, h.from_user_id AS "fromUserId", sender.display_name AS "fromName",
       h.to_user_id AS "toUserId", recipient.display_name AS "toName",
       h.accepted_by AS "acceptedBy", winner.display_name AS "acceptedName", h.note, h.status,
       h.expires_at AS "expiresAt", h.checkpoint_sha AS "checkpointSha"
     FROM run_handoffs h JOIN users sender ON sender.id = h.from_user_id
     LEFT JOIN users recipient ON recipient.id = h.to_user_id
     LEFT JOIN users winner ON winner.id = h.accepted_by
     WHERE h.run_id = $1 ORDER BY h.created_at DESC LIMIT 30`, [runId],
  );
  const recipients = await query<{ id: string; name: string }>(
    `SELECT id, display_name AS name FROM users WHERE id IN (
       SELECT user_id FROM session_members WHERE session_id = $1 AND removed_at IS NULL
       UNION SELECT pm.user_id FROM project_members pm JOIN sessions s ON s.project_id = pm.project_id WHERE s.id = $1
       UNION SELECT om.user_id FROM org_members om JOIN sessions s ON s.org_id = om.org_id WHERE s.id = $1
     ) AND room_access_role($1, id) IN ('owner', 'editor') ORDER BY display_name`, [sessionId],
  );
  return { offers, recipients };
}

export type HandoffAction =
  | { action: "offer"; toUserId: string | null; note: string; version: number }
  | { action: "accept" | "decline" | "cancel"; handoffId: string; version: number }
  | { action: "recover"; version: number };

export async function changeHandoff(runId: string, sessionId: string, actorId: string, input: HandoffAction) {
  return transaction(async (tx) => {
    const { rows: [run] } = await tx.query(
      `SELECT *, room_access_role(session_id, $2) AS actor_role FROM agent_runs
       WHERE id = $1 AND session_id = $3 FOR UPDATE`, [runId, actorId, sessionId],
    );
    if (!run || !["owner", "editor"].includes(run.actor_role)) throw new ControlError("Edit access is required.", 403);
    await tx.query(`UPDATE run_handoffs SET status = 'expired', resolved_at = now()
      WHERE run_id = $1 AND status = 'pending' AND expires_at <= now()`, [runId]);

    if (input.action === "offer") {
      if (run.driver_user_id !== actorId) throw new ControlError("Only the current driver can offer this chat.", 403);
      if (run.control_version !== input.version) throw new ControlError("Control changed. Refresh the chat.");
      if (input.toUserId) {
        const { rows: [recipient] } = await tx.query(`SELECT room_access_role($1, $2) AS role`, [sessionId, input.toUserId]);
        if (input.toUserId === actorId || !["owner", "editor"].includes(recipient?.role)) {
          throw new ControlError("Choose another editor with access to this room.", 400);
        }
      }
      const { rows: [pending] } = await tx.query(`SELECT id FROM run_handoffs WHERE run_id = $1 AND status = 'pending'`, [runId]);
      if (pending) throw new ControlError("A handoff is already waiting. Cancel it before offering again.");
      await tx.query(`INSERT INTO run_handoffs(run_id, from_user_id, to_user_id, note, control_version)
        VALUES ($1, $2, $3, $4, $5)`, [runId, actorId, input.toUserId, input.note, run.control_version]);
      return;
    }

    if (input.action === "recover") {
      if (run.actor_role !== "owner") throw new ControlError("Only the room owner can recover control.", 403);
      if (run.control_version !== input.version) throw new ControlError("Control changed. Refresh the chat.");
      const { rows: [active] } = await tx.query(
        `SELECT t.*, j.status AS job_status, j.lease_expires_at,
           CASE WHEN t.execution_target='server' AND t.status='running'
             THEN COALESCE(t.execution_lease_until,t.created_at+interval '12 minutes')<now()
             WHEN j.status='claimed' THEN false
             ELSE t.created_at<now()-interval '15 minutes' END AS timed_out,
           j.lease_expires_at < now() AS lease_expired
         FROM agent_turns t LEFT JOIN runner_jobs j ON j.turn_id = t.id
         WHERE t.run_id = $1 AND t.status IN ('preparing', 'queued', 'running') FOR UPDATE OF t`, [runId],
      );
      if (active) {
        if (active.completion || (!active.timed_out && !active.lease_expired)) {
          throw new ControlError("Execution is still active or finalizing. Wait before recovering control.");
        }
        await closeTurnInputs(tx, active.id);
        await tx.query(`UPDATE agent_turns SET status = 'cancelled', ended_at = now() WHERE id = $1`, [active.id]);
        await tx.query(`UPDATE runner_jobs SET status = 'failed' WHERE turn_id = $1`, [active.id]);
      } else if (["running", "queued"].includes(run.status)) {
        throw new ControlError("This legacy execution must be stopped by the server operator before recovery.");
      } else {
        const { rows: [driver] } = await tx.query(`SELECT room_access_role($1, $2) AS role`, [sessionId, run.driver_user_id]);
        if (["owner", "editor"].includes(driver?.role)) {
          const { rows: [online] } = await tx.query(`SELECT id FROM runner_devices WHERE user_id = $1 AND revoked_at IS NULL AND last_seen_at > now() - interval '2 minutes' LIMIT 1`, [run.driver_user_id]);
          if (online) throw new ControlError("The driver is still online. Ask them to offer a handoff.");
        }
      }
      await tx.query(`UPDATE run_handoffs SET status = 'cancelled', resolved_at = now() WHERE run_id = $1 AND status = 'pending'`, [runId]);
      await tx.query(`UPDATE agent_runs SET driver_user_id = $2, control_version = control_version + 1,
        status = 'cancelled', ended_at = now() WHERE id = $1`, [runId, actorId]);
      await tx.query(`INSERT INTO run_handoffs(run_id, from_user_id, accepted_by, control_version, note, status, resolved_at)
        VALUES ($1, $2, $3, $4, 'Room owner recovered control from an unavailable driver or abandoned execution.', 'accepted', now())`,
      [runId, run.driver_user_id, actorId, run.control_version]);
      return;
    }

    const { rows: [offer] } = await tx.query(`SELECT * FROM run_handoffs WHERE id = $1 AND run_id = $2 FOR UPDATE`, [input.handoffId, runId]);
    if (!offer) throw new ControlError("Handoff not found.", 404);
    const targetStatus = input.action === "accept" ? "accepted" : input.action === "cancel" ? "cancelled" : "declined";
    const sameActor = input.action === "accept" ? offer.accepted_by === actorId
      : input.action === "cancel" ? offer.from_user_id === actorId : offer.to_user_id === actorId;
    if (offer.status === targetStatus && sameActor) return;
    if (offer.status !== "pending") throw new ControlError(`This handoff is ${offer.status}.`);
    if (run.control_version !== input.version || offer.control_version !== run.control_version || offer.from_user_id !== run.driver_user_id) {
      throw new ControlError("Control changed. Refresh the chat.");
    }
    if (input.action === "cancel") {
      if (offer.from_user_id !== actorId) throw new ControlError("Only the sender can cancel.", 403);
    } else {
      if (offer.from_user_id === actorId || (offer.to_user_id && offer.to_user_id !== actorId)) throw new ControlError("This handoff is for another teammate.", 403);
      if (input.action === "decline" && !offer.to_user_id) throw new ControlError("An open offer can be ignored, not declined for everyone.", 400);
    }
    if (input.action === "accept") {
      if (["running", "queued"].includes(run.status)) throw new ControlError("Wait for the active turn to finish before accepting.");
      const { rows: [repo] } = await tx.query(run.repo_id
        ? `SELECT head_sha FROM room_repos WHERE id = $1 AND seeded_at IS NOT NULL`
        : `SELECT head_sha FROM session_repos WHERE session_id = $1`, [run.repo_id ?? sessionId]);
      if (!repo) throw new ControlError("The chat's repository is not ready.");
      await tx.query(`UPDATE agent_runs SET driver_user_id = $2, control_version = control_version + 1 WHERE id = $1`, [runId, actorId]);
      // An isolated chat hands off its own branch tip, not the room's.
      await tx.query(`UPDATE run_handoffs SET status = 'accepted', accepted_by = $2, resolved_at = now(),
        checkpoint_sha = $3, checkpoint_seq = $4 WHERE id = $1`, [offer.id, actorId, run.isolation === "isolated" ? run.head_sha : repo.head_sha, run.message_seq]);
    } else {
      await tx.query(`UPDATE run_handoffs SET status = $2, resolved_at = now() WHERE id = $1`, [offer.id, targetStatus]);
    }
  });
}

export async function continuationContext(runId: string): Promise<string> {
  const messages = await query<{ role: string; body: string; name: string | null }>(
    `SELECT m.role, m.body, u.display_name AS name FROM agent_run_messages m
     LEFT JOIN users u ON u.id = m.author_user_id WHERE m.run_id = $1
     AND m.role IN ('user', 'agent', 'system') ORDER BY m.seq DESC LIMIT 24`, [runId],
  );
  const handoffs = await query<{ note: string; checkpoint_sha: string | null }>(
    `SELECT note, checkpoint_sha FROM run_handoffs WHERE run_id = $1 AND status = 'accepted'
     ORDER BY resolved_at DESC LIMIT 3`, [runId],
  );
  return [
    ...messages.reverse().map(message => `${message.role}${message.name ? ` (${message.name})` : ""}: ${message.body.slice(0, 1800)}`),
    ...handoffs.reverse().map(offer => `Handoff checkpoint: ${offer.checkpoint_sha ?? "last confirmed repository state"}\nHandoff note: ${offer.note || "No note provided."}`),
  ].join("\n\n");
}

export type InboxHandoff = {
  id: string;
  runId: string;
  sessionId: string;
  title: string | null;
  roomName: string;
  projectName: string | null;
  orgSlug: string | null;
  /** The person on the other side: who offered it (received) or to whom (sent; null = any editor). */
  person: string | null;
  note: string;
  expiresAt: string;
  createdAt: string;
  /** The chat's control version, which accepting, declining or cancelling must quote. */
  version: number;
  /** Offered to you by name (not to any editor of the room): only these can be declined. */
  direct: boolean;
  /** The chat is working right now; it can be accepted once that finishes. */
  busy: boolean;
};

/**
 * Handoffs waiting on a member, across every room they can edit: ones offered
 * to them (or to any editor of the room) and ones they offered and are still
 * waiting for. Expired, superseded and hidden chats are left out.
 */
export async function listMyHandoffs(userId: string): Promise<{ received: InboxHandoff[]; sent: InboxHandoff[] }> {
  const columns = `h.id, h.run_id AS "runId", r.session_id AS "sessionId", r.title, s.name AS "roomName", p.name AS "projectName",
    o.slug AS "orgSlug", h.note, h.expires_at::text AS "expiresAt", h.created_at::text AS "createdAt",
    r.control_version AS version, h.to_user_id IS NOT NULL AS direct, r.status IN ('running', 'queued') AS busy`;
  const from = `FROM run_handoffs h JOIN agent_runs r ON r.id = h.run_id JOIN sessions s ON s.id = r.session_id
    LEFT JOIN projects p ON p.id = s.project_id LEFT JOIN orgs o ON o.id = s.org_id`;
  const live = `h.status = 'pending' AND h.expires_at > now() AND h.control_version = r.control_version
    AND h.from_user_id = r.driver_user_id AND s.deleted_at IS NULL AND NOT agent_run_hidden(r.id, $1)`;
  const [received, sent] = await Promise.all([
    query<InboxHandoff>(`SELECT ${columns}, sender.display_name AS person ${from} JOIN users sender ON sender.id = h.from_user_id
      WHERE ${live} AND h.from_user_id <> $1 AND (h.to_user_id = $1 OR h.to_user_id IS NULL)
        AND room_access_role(r.session_id, $1) IN ('owner', 'editor')
      ORDER BY h.created_at DESC LIMIT 50`, [userId]),
    query<InboxHandoff>(`SELECT ${columns}, recipient.display_name AS person ${from} LEFT JOIN users recipient ON recipient.id = h.to_user_id
      WHERE ${live} AND h.from_user_id = $1 AND room_access_role(r.session_id, $1) IN ('owner', 'editor')
      ORDER BY h.created_at DESC LIMIT 50`, [userId]),
  ]);
  return { received, sent };
}

/** Who should hear that a chat's handoff changed: its sender, and everyone it was (or could be) offered to. */
export async function handoffAudience(runId: string, sessionId: string): Promise<string[]> {
  const rows = await query<{ user_id: string }>(
    `WITH recent AS (SELECT from_user_id, to_user_id FROM run_handoffs WHERE run_id = $1 AND created_at > now() - interval '2 hours')
     SELECT from_user_id AS user_id FROM recent
     UNION SELECT to_user_id FROM recent WHERE to_user_id IS NOT NULL
     UNION SELECT m.user_id FROM (
         SELECT user_id FROM session_members WHERE session_id = $2 AND removed_at IS NULL
         UNION SELECT pm.user_id FROM project_members pm JOIN sessions s ON s.project_id = pm.project_id WHERE s.id = $2
         UNION SELECT om.user_id FROM org_members om JOIN sessions s ON s.org_id = om.org_id WHERE s.id = $2
       ) m
       WHERE EXISTS (SELECT 1 FROM recent WHERE to_user_id IS NULL) AND room_access_role($2, m.user_id) IN ('owner', 'editor')`,
    [runId, sessionId]);
  return rows.map((row) => row.user_id);
}
