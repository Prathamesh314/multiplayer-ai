import { query, queryOne, transaction } from "../db/client";
import type { AgentId } from "./catalog";

/**
 * Agent runs: the durable side of what used to be a fire-and-forget stream.
 *
 * A run belongs to a room, is started by one member, and carries an ordered
 * conversation. Others can watch it or join to co-drive; who may do so is
 * settled by their project role (see project/store.ts), so this module only
 * records attention, never grants room access.
 */

export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type RunMessageRole = "user" | "agent" | "system" | "tool";
export type RunParticipantRole = "owner" | "editor" | "viewer";

export type AgentRun = {
  id: string;
  sessionId: string;
  /** The room repo this chat works on; null = the room's own project fork. */
  repoId: string | null;
  startedBy: string;
  startedByName: string;
  driverUserId: string;
  driverName: string;
  controlVersion: number;
  restoreSnapshotId?: string | null;
  agentId: string;
  title: string | null;
  status: RunStatus;
  baseSha: string;
  resultSha: string | null;
  /** Lines added/removed between base and result; null until the run finishes. */
  addedLines: number | null;
  removedLines: number | null;
  exitCode: number | null;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  /** Set when the starter archived it out of the active list; null while live. */
  archivedAt: number | null;
};

export type AgentRunMessage = {
  id: string;
  runId: string;
  seq: number;
  role: RunMessageRole;
  authorUserId: string | null;
  authorName: string | null;
  body: string;
  createdAt: number;
};

export type RunsResponse = { runs: AgentRun[] };
export type RunResponse = { run: AgentRun; messages: AgentRunMessage[] };
export type StartRunRequest = { agentId: AgentId; prompt: string; title?: string };

type RunRow = {
  id: string;
  session_id: string;
  repo_id: string | null;
  started_by: string;
  started_by_name: string;
  driver_user_id: string;
  driver_name: string;
  control_version: number;
  restore_snapshot_id: string | null;
  agent_id: string;
  title: string | null;
  status: RunStatus;
  base_sha: string;
  result_sha: string | null;
  added_lines: number | null;
  removed_lines: number | null;
  exit_code: number | null;
  error: string | null;
  created_at: Date;
  started_at: Date | null;
  ended_at: Date | null;
  archived_at: Date | null;
};

const toRun = (row: RunRow): AgentRun => ({
  id: row.id,
  sessionId: row.session_id,
  repoId: row.repo_id,
  startedBy: row.started_by,
  startedByName: row.started_by_name,
  driverUserId: row.driver_user_id,
  driverName: row.driver_name,
  controlVersion: row.control_version,
  restoreSnapshotId: row.restore_snapshot_id,
  agentId: row.agent_id,
  title: row.title,
  status: row.status,
  baseSha: row.base_sha,
  resultSha: row.result_sha,
  addedLines: row.added_lines,
  removedLines: row.removed_lines,
  exitCode: row.exit_code,
  error: row.error,
  createdAt: row.created_at.getTime(),
  startedAt: row.started_at ? row.started_at.getTime() : null,
  endedAt: row.ended_at ? row.ended_at.getTime() : null,
  archivedAt: row.archived_at ? row.archived_at.getTime() : null,
});

const RUN_COLUMNS = `
  r.id, r.session_id, r.repo_id, r.driver_user_id, r.control_version, r.restore_snapshot_id,
  (SELECT display_name FROM users WHERE id = r.driver_user_id) AS driver_name, r.started_by, u.display_name AS started_by_name, r.agent_id,
  r.title, r.status, r.base_sha, r.result_sha, r.added_lines, r.removed_lines,
  r.exit_code, r.error, r.created_at, r.started_at, r.ended_at, r.archived_at
`;

/**
 * Opens a run. The starter is recorded as its owner participant in the same
 * transaction, so a run always has at least the person who began it watching.
 */
export async function createRun(input: {
  sessionId: string;
  startedBy: string;
  agentId: AgentId;
  baseSha: string;
  title?: string | null;
  /**
   * "auto" is a drafted name that background refinement may still replace
   * once; "manual" is a name someone chose, which nothing automatic touches.
   */
  titleSource?: "auto" | "manual";
  /** Which room repo the chat targets; null/omitted = the project fork. */
  repoId?: string | null;
}): Promise<AgentRun> {
  return transaction(async (tx) => {
    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO agent_runs (session_id, repo_id, started_by, driver_user_id, agent_id, base_sha, title, title_source, status, started_at)
       VALUES ($1, $2, $3, $3, $4, $5, $6, $7, 'completed', NULL)
       RETURNING id`,
      [
        input.sessionId,
        input.repoId ?? null,
        input.startedBy,
        input.agentId,
        input.baseSha,
        input.title ?? null,
        input.titleSource ?? "auto",
      ],
    );
    const id = inserted.rows[0].id;
    await tx.query(
      `INSERT INTO agent_run_participants (run_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [id, input.startedBy],
    );
    const row = await tx.query<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM agent_runs r JOIN users u ON u.id = r.started_by WHERE r.id = $1`,
      [id],
    );
    return toRun(row.rows[0]);
  });
}

/**
 * Appends one turn. seq is allocated as MAX+1 within the run in the same
 * statement, so it stays gap-free without a separate counter; concurrent
 * appends to one run don't happen — a run has a single writer process.
 */
export async function appendMessage(input: {
  runId: string;
  role: RunMessageRole;
  authorUserId?: string | null;
  body: string;
}): Promise<AgentRunMessage> {
  const row = await queryOne<{
    id: string;
    run_id: string;
    seq: string;
    role: RunMessageRole;
    author_user_id: string | null;
    body: string;
    created_at: Date;
  }>(
    `WITH allocated AS (
       UPDATE agent_runs SET message_seq = message_seq + 1 WHERE id = $1 RETURNING message_seq
     )
     INSERT INTO agent_run_messages (run_id, seq, role, author_user_id, body)
     SELECT $1, message_seq, $2, $3, $4 FROM allocated
     RETURNING id, run_id, seq, role, author_user_id, body, created_at`,
    [input.runId, input.role, input.authorUserId ?? null, input.body],
  );
  return {
    id: row!.id,
    runId: row!.run_id,
    seq: Number(row!.seq),
    role: row!.role,
    authorUserId: row!.author_user_id,
    authorName: null,
    body: row!.body,
    createdAt: row!.created_at.getTime(),
  };
}

/** Closes a run out with its terminal status and the commit it produced. */
/**
 * Whether anyone other than `userId` has already sent a prompt into this run —
 * i.e. it is being co-driven. When true, prompts to the agent are tagged with
 * who is speaking so two people's intents in one run stay legible.
 */
export async function runHasOtherAuthors(runId: string, userId: string): Promise<boolean> {
  const row = await queryOne<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM agent_run_messages
        WHERE run_id = $1 AND role = 'user'
          AND author_user_id IS NOT NULL AND author_user_id <> $2
     ) AS present`,
    [runId, userId],
  );
  return row?.present ?? false;
}

/**
 * Marks an existing run running again — used when a follow-up prompt continues
 * it, so the concurrency accounting counts the live process it just spawned.
 */
export async function reopenRun(runId: string): Promise<void> {
  await query(
    `UPDATE agent_runs SET status = 'running', ended_at = NULL, started_at = now()
      WHERE id = $1`,
    [runId],
  );
}

export async function finishRun(
  runId: string,
  outcome: {
    status: RunStatus;
    resultSha?: string | null;
    exitCode?: number | null;
    error?: string | null;
    addedLines?: number | null;
    removedLines?: number | null;
  },
): Promise<void> {
  await query(
    `UPDATE agent_runs
        SET status = $2, result_sha = $3, exit_code = $4, error = $5,
            added_lines = $6, removed_lines = $7, ended_at = now()
      WHERE id = $1`,
    [
      runId,
      outcome.status,
      outcome.resultSha ?? null,
      outcome.exitCode ?? null,
      outcome.error ?? null,
      outcome.addedLines ?? null,
      outcome.removedLines ?? null,
    ],
  );
}

/**
 * Renames a run on a person's instruction. This is the only way a title
 * becomes 'manual', and once it is, nothing automatic writes it again.
 */
export async function renameRun(runId: string, title: string): Promise<void> {
  await query(`UPDATE agent_runs SET title = $2, title_source = 'manual' WHERE id = $1`, [runId, title]);
}

/**
 * Replaces a drafted name with a refined one. A no-op once the driver has
 * renamed the chat themselves — the WHERE clause is the whole guarantee that
 * background refinement can never overwrite a deliberate name, including when
 * the rename lands while the refinement request is still in flight.
 *
 * Returns the title now in effect, so a caller can skip broadcasting a change
 * that did not happen.
 */
export async function autoRenameRun(runId: string, title: string): Promise<string | null> {
  const row = await queryOne<{ title: string | null }>(
    `UPDATE agent_runs SET title = $2
      WHERE id = $1 AND title_source = 'auto' AND title IS DISTINCT FROM $2
      RETURNING title`,
    [runId, title],
  );
  return row?.title ?? null;
}

/** Archives or restores a run — a personal hide, set only by its starter. */
export async function setRunArchived(runId: string, archived: boolean): Promise<void> {
  await query(
    `UPDATE agent_runs SET archived_at = ${archived ? "now()" : "NULL"} WHERE id = $1`,
    [runId],
  );
}

/** The run list for a room, newest first. */
export async function listRuns(sessionId: string): Promise<AgentRun[]> {
  const rows = await query<RunRow>(
    `SELECT ${RUN_COLUMNS}
       FROM agent_runs r JOIN users u ON u.id = r.started_by
      WHERE r.session_id = $1
      ORDER BY r.created_at DESC`,
    [sessionId],
  );
  return rows.map(toRun);
}

export type ForkableRun = {
  id: string;
  sessionId: string;
  sessionName: string;
  startedByName: string;
  agentId: string;
  title: string | null;
  status: RunStatus;
  createdAt: number;
};

/**
 * Candidate source runs for "import context from…" — across whichever rooms
 * the caller may see, not just the one they're in. Room access is resolved by
 * the caller (see visibleRoomIds); this just fetches runs for the given ids.
 */
export async function listRunsForRooms(sessionIds: string[], limit = 50): Promise<ForkableRun[]> {
  if (sessionIds.length === 0) return [];
  const rows = await query<{
    id: string;
    session_id: string;
    session_name: string;
    started_by_name: string;
    agent_id: string;
    title: string | null;
    status: RunStatus;
    created_at: Date;
  }>(
    `SELECT r.id, r.session_id, s.name AS session_name, u.display_name AS started_by_name,
            r.agent_id, r.title, r.status, r.created_at
       FROM agent_runs r
       JOIN sessions s ON s.id = r.session_id
       JOIN users u ON u.id = r.started_by
      WHERE r.session_id = ANY($1)
      ORDER BY r.created_at DESC
      LIMIT $2`,
    [sessionIds, limit],
  );
  return rows.map((row) => ({
    id: row.id,
    sessionId: row.session_id,
    sessionName: row.session_name,
    startedByName: row.started_by_name,
    agentId: row.agent_id,
    title: row.title,
    status: row.status,
    createdAt: row.created_at.getTime(),
  }));
}

export async function getRun(runId: string): Promise<AgentRun | null> {
  const row = await queryOne<RunRow>(
    `SELECT ${RUN_COLUMNS}
       FROM agent_runs r JOIN users u ON u.id = r.started_by WHERE r.id = $1`,
    [runId],
  );
  return row ? toRun(row) : null;
}

/** A run's conversation, oldest first, optionally only turns after `afterSeq`. */
export async function listRunMessages(runId: string, afterSeq = 0): Promise<AgentRunMessage[]> {
  const rows = await query<{
    id: string;
    run_id: string;
    seq: string;
    role: RunMessageRole;
    author_user_id: string | null;
    author_name: string | null;
    body: string;
    created_at: Date;
  }>(
    `SELECT m.id, m.run_id, m.seq, m.role, m.author_user_id, u.display_name AS author_name,
            m.body, m.created_at
       FROM agent_run_messages m
       LEFT JOIN users u ON u.id = m.author_user_id
      WHERE m.run_id = $1 AND m.seq > $2
      ORDER BY m.seq`,
    [runId, afterSeq],
  );
  return rows.map((row) => ({
    id: row.id,
    runId: row.run_id,
    seq: Number(row.seq),
    role: row.role,
    authorUserId: row.author_user_id,
    authorName: row.author_name,
    body: row.body,
    createdAt: row.created_at.getTime(),
  }));
}

/** Records that someone is watching or co-driving. Idempotent, and un-leaves. */
export async function joinRun(
  runId: string,
  userId: string,
  role: RunParticipantRole,
): Promise<void> {
  await query(
    `INSERT INTO agent_run_participants (run_id, user_id, role)
     VALUES ($1, $2, $3)
     ON CONFLICT (run_id, user_id) DO UPDATE SET role = EXCLUDED.role, left_at = NULL`,
    [runId, userId, role],
  );
}

export async function leaveRun(runId: string, userId: string): Promise<void> {
  await query(
    `UPDATE agent_run_participants SET left_at = now()
      WHERE run_id = $1 AND user_id = $2 AND left_at IS NULL`,
    [runId, userId],
  );
}
