import { events } from "../events";
import { query, queryOne, transaction } from "../db/client";
import { agentById } from "../ai/catalog";
import { isUUID, isSelfAssignment, SELF_ASSIGNMENT_ERROR, taskStatuses, type RoomTask, type TaskMember, type TaskStatus } from "./types";

export class TaskError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

const columns = `t.id, t.run_id AS "runId", r.session_id AS "sessionId", s.name AS "roomName",
  COALESCE(r.title, 'Untitled chat') AS "chatTitle", t.created_by AS "createdBy",
  creator.display_name AS "creatorName", t.assignee_id AS "assigneeId",
  assignee.display_name AS "assigneeName", assignee.handle AS "assigneeHandle",
  t.body, t.status, t.created_at::text AS "createdAt"`;
const joins = `FROM room_tasks t JOIN agent_runs r ON r.id=t.run_id
  JOIN sessions s ON s.id=r.session_id JOIN users creator ON creator.id=t.created_by
  JOIN users assignee ON assignee.id=t.assignee_id`;

export async function taskMembers(sessionId: string, actor: string): Promise<TaskMember[]> {
  // Resolve the actor once, then check only people who could inherit access.
  // Ordinary organization members do not inherit room access. Including all of
  // them here made every small room's picker scale with the whole organization.
  // Keep the authoritative role check for revocation and viewer precedence.
  return query<TaskMember>(`WITH room AS MATERIALIZED (
      SELECT id, project_id, org_id, visibility FROM sessions
      WHERE id=$1 AND deleted_at IS NULL AND room_access_role(id,$2) IS NOT NULL
    ), candidates AS MATERIALIZED (
      SELECT m.user_id FROM room r JOIN session_members m ON m.session_id=r.id
        WHERE m.removed_at IS NULL
      UNION SELECT m.user_id FROM room r JOIN project_members m ON m.project_id=r.project_id
        WHERE r.visibility='public' AND m.removed_at IS NULL
      UNION SELECT m.user_id FROM room r JOIN org_members m ON m.org_id=r.org_id
        WHERE r.visibility='public' AND m.status='active' AND m.role IN ('owner','admin')
    ) SELECT u.id AS "userId", u.handle, u.display_name AS "displayName"
    FROM candidates c JOIN users u ON u.id=c.user_id
    WHERE u.id<>$2 AND room_access_role($1,u.id) IS NOT NULL
    ORDER BY u.display_name, u.handle`, [sessionId,actor]);
}

export async function listTasks(actor: string, scope?: { sessionId: string; runId: string }, offset = 0) {
  if (scope && !isUUID(scope.runId)) throw new TaskError("Invalid chat ID.");
  return query<RoomTask>(`SELECT ${columns} ${joins}
    WHERE room_access_role(r.session_id,$1) IS NOT NULL
    AND ${scope ? 'r.session_id=$2 AND r.id=$3' : 't.assignee_id=$1'}
    ORDER BY t.created_at DESC, t.id DESC LIMIT 51 OFFSET $${scope ? 4 : 2}`,
    scope ? [actor,scope.sessionId,scope.runId,offset] : [actor,offset]);
}

export async function createTask(actor: string, input: unknown): Promise<{ id: string; runId: string }> {
  if (!input || typeof input !== "object") throw new TaskError("Expected a task.");
  const { id, sessionId, runId: existingRunId, assigneeId, body, newChat } = input as Record<string,unknown>;
  const chat = newChat && typeof newChat === "object" ? newChat as Record<string,unknown> : null;
  // A new chat and its first task share a request ID so retries cannot create
  // orphan chats. Both records commit together; no AI turn is submitted.
  const runId = chat ? id : existingRunId;
  if (newChat !== undefined && (!chat || existingRunId !== undefined ||
      typeof chat.agentId !== "string" || !agentById(chat.agentId) ||
      (chat.repoId !== null && typeof chat.repoId !== "string"))) throw new TaskError("Invalid new chat.");
  if (!isUUID(id) || !isUUID(runId) || !isUUID(assigneeId) || typeof sessionId !== "string" ||
      typeof body !== "string" || !body.trim() || body.trim().length > 4000) {
    throw new TaskError("Choose a room member and enter a task of 1–4000 characters.");
  }
  // Validate before creating either record: a rejected assignment must not
  // leave an empty source chat or consume its retry ID.
  if (isSelfAssignment(actor, assigneeId)) throw new TaskError(SELF_ASSIGNMENT_ERROR);
  const result = await transaction(async tx => {
    if (chat) {
      const access = await tx.query(`SELECT id FROM sessions WHERE id=$1
        AND room_access_role(id,$2) IN ('owner','editor') AND room_access_role(id,$3) IS NOT NULL`,
      [sessionId,actor,assigneeId]);
      if (!access.rows.length) throw new TaskError("You cannot assign this task. Check room access for you and the assignee.",403);
      const repo = chat.repoId === null
        ? await tx.query(`SELECT head_sha FROM session_repos WHERE session_id=$1`,[sessionId])
        : await tx.query(`SELECT head_sha FROM room_repos WHERE id=$1 AND session_id=$2 AND seeded_at IS NOT NULL`,[chat.repoId,sessionId]);
      if (chat.repoId !== null && !repo.rows[0]?.head_sha) throw new TaskError("Repository not ready or not in this room.",409);
      const created = await tx.query(`INSERT INTO agent_runs(id,session_id,repo_id,started_by,driver_user_id,agent_id,base_sha,title,status)
        VALUES ($1,$2,$3,$4,$4,$5,$6,$7,'completed') ON CONFLICT (id) DO NOTHING RETURNING id`,
      [runId,sessionId,chat.repoId,actor,chat.agentId,repo.rows[0]?.head_sha ?? "",body.trim().slice(0,200)]);
      if (created.rows.length) {
        await tx.query(`INSERT INTO agent_run_participants(run_id,user_id,role) VALUES ($1,$2,'owner')`,[runId,actor]);
      } else {
        const retry = await tx.query(`SELECT r.id FROM agent_runs r JOIN room_tasks t ON t.run_id=r.id
          WHERE r.id=$1 AND r.session_id=$2 AND r.started_by=$3 AND r.repo_id IS NOT DISTINCT FROM $4
          AND r.agent_id=$5 AND t.id=$1 AND t.created_by=$3 AND t.assignee_id=$6 AND t.body=$7`,
        [runId,sessionId,actor,chat.repoId,chat.agentId,assigneeId,body.trim()]);
        if (!retry.rows.length) throw new TaskError("This request ID was already used. Start a new task.",409);
      }
    }
    const allowed = await tx.query(`SELECT id FROM agent_runs WHERE id=$1 AND session_id=$2
      AND room_access_role(session_id,$3) IN ('owner','editor')
      AND room_access_role(session_id,$4) IS NOT NULL`, [runId,sessionId,actor,assigneeId]);
    if (!allowed.rows.length) throw new TaskError("You cannot assign this task. Check room access for you and the assignee.",403);
    const inserted = await tx.query(`INSERT INTO room_tasks(id,run_id,created_by,assignee_id,body)
      VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING RETURNING id`, [id,runId,actor,assigneeId,body.trim()]);
    if (!inserted.rows.length) {
      const existing = await tx.query(`SELECT id FROM room_tasks WHERE id=$1 AND run_id=$2
        AND created_by=$3 AND assignee_id=$4 AND body=$5`, [id,runId,actor,assigneeId,body.trim()]);
      if (!existing.rows.length) throw new TaskError("This request ID was already used. Start a new task.",409);
    }
    return { id, runId };
  });
  await notifyTask(sessionId, actor, assigneeId);
  return result;
}

export async function updateTask(actor: string, id: string, status: unknown) {
  if (!isUUID(id) || !taskStatuses.includes(status as TaskStatus)) throw new TaskError("Invalid task or status.");
  const row = await queryOne(`UPDATE room_tasks t SET status=$3, updated_at=now()
    FROM agent_runs r WHERE t.id=$1 AND r.id=t.run_id
    AND room_access_role(r.session_id,$2) IS NOT NULL
    AND (t.assignee_id=$2 OR (t.created_by=$2 AND room_access_role(r.session_id,$2) IN ('owner','editor')))
    RETURNING t.id,r.session_id,t.created_by,t.assignee_id`, [id,actor,status]);
  if (!row) throw new TaskError("Task unavailable, or you cannot update it.",403);
  await notifyTask(row.session_id as string, row.created_by as string, row.assignee_id as string);
}

async function notifyTask(room: string, creator: string, assignee: string) {
  const bus = await events();
  await Promise.all([room, `user:${creator}`, `user:${assignee}`].map(scope => bus.publish(scope, { type: "tasks.changed", at: Date.now() }))).catch(() => {});
}
