import { query, queryOne, transaction } from "../db/client";
import { isUUID, taskStatuses, type RoomTask, type TaskMember, type TaskStatus } from "./types";

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
  return query<TaskMember>(`SELECT u.id AS "userId", u.handle, u.display_name AS "displayName"
    FROM users u WHERE u.id IN (
      SELECT user_id FROM session_members WHERE session_id=$1
      UNION SELECT user_id FROM project_members WHERE project_id=(SELECT project_id FROM sessions WHERE id=$1)
      UNION SELECT user_id FROM org_members WHERE org_id=(SELECT org_id FROM sessions WHERE id=$1)
    ) AND room_access_role($1,$2) IS NOT NULL AND room_access_role($1,u.id) IS NOT NULL
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

export async function createTask(actor: string, input: unknown): Promise<string> {
  if (!input || typeof input !== "object") throw new TaskError("Expected a task.");
  const { id, sessionId, runId, assigneeId, body } = input as Record<string,unknown>;
  if (!isUUID(id) || !isUUID(runId) || !isUUID(assigneeId) || typeof sessionId !== "string" ||
      typeof body !== "string" || !body.trim() || body.trim().length > 4000) {
    throw new TaskError("Choose a room member and enter a task of 1–4000 characters.");
  }
  return transaction(async tx => {
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
    return id;
  });
}

export async function updateTask(actor: string, id: string, status: unknown) {
  if (!isUUID(id) || !taskStatuses.includes(status as TaskStatus)) throw new TaskError("Invalid task or status.");
  const row = await queryOne(`UPDATE room_tasks t SET status=$3, updated_at=now()
    FROM agent_runs r WHERE t.id=$1 AND r.id=t.run_id
    AND room_access_role(r.session_id,$2) IS NOT NULL
    AND (t.assignee_id=$2 OR (t.created_by=$2 AND room_access_role(r.session_id,$2) IN ('owner','editor')))
    RETURNING t.id`, [id,actor,status]);
  if (!row) throw new TaskError("Task unavailable, or you cannot update it.",403);
}
