import { query, queryOne, transaction } from "../db/client";
import { events } from "../events";
import type { AgentRunJob } from "./run-events";
import { isUuid } from "./turns";

/*
 * Asking the chat before an agent uses a tool that needs permission.
 *
 * Agents run unattended on members' computers. When one wants a tool its CLI
 * would normally ask about (fetching a web page, an MCP connector such as
 * Google Drive, a shell command), the runner records the request here and waits.
 * The chat shows it, and only the chat's driver, the member whose computer and
 * AI account are doing the work, can allow or deny it. "Always allow" adds the
 * request's rule to the chat, and later turns pass it to the CLI up front.
 *
 * The driver can instead put a chat in Auto mode: then every request is
 * allowed at once, without asking, and kept as "allowed automatically" so the
 * chat still shows what the agent did. Manual ("ask") is the default.
 */

export type PermissionStatus = "pending" | "allowed" | "denied" | "expired";
export type PermissionDecision = "allow" | "always" | "deny";
export type PermissionRequest = {
  id: string;
  turnId: string;
  tool: string;
  title: string;
  detail: string | null;
  rule: string | null;
  status: PermissionStatus;
  remember: boolean;
  /** Allowed by the chat's Auto mode rather than by a person. */
  automatic: boolean;
  decidedBy: string | null;
  createdAt: number;
};
export class PermissionError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

type Row = { id: string; turn_id: string; tool: string; title: string; detail: string | null; rule: string | null;
  status: PermissionStatus; remember: boolean; automatic: boolean; decided_by_name: string | null; created_at: Date };
const toRequest = (row: Row): PermissionRequest => ({
  id: row.id, turnId: row.turn_id, tool: row.tool, title: row.title, detail: row.detail, rule: row.rule,
  status: row.status, remember: row.remember, automatic: row.automatic, decidedBy: row.decided_by_name, createdAt: row.created_at.getTime(),
});

const text = (value: unknown, max: number) => typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
/** A rule the CLIs understand: a tool name, optionally with a parenthesised specifier. */
export const validRule = (rule: unknown): rule is string =>
  typeof rule === "string" && rule.length <= 300 && /^[A-Za-z0-9_.-]+(\([^()\n]{1,280}\))?$/.test(rule);

async function signal(sessionId: string, runId: string) {
  await (await events()).publish(sessionId, { type: "run.permission", runId, at: Date.now() }).catch(() => {});
}

/**
 * The runner asks. Idempotent by request id; a rule the chat always allows, or
 * any request in an Auto chat, is granted at once. Returns its current status.
 */
export async function requestPermission(job: AgentRunJob, input: { id?: unknown; tool?: unknown; title?: unknown; detail?: unknown; rule?: unknown }): Promise<PermissionStatus> {
  const id = input.id, tool = text(input.tool, 200), title = text(input.title, 300);
  if (!isUuid(id) || !tool || !title) throw new PermissionError("Invalid permission request.");
  const rule = validRule(input.rule) ? input.rule : null;
  const status = await transaction(async (tx) => {
    const chat = (await tx.query<{ remembered: boolean; auto: boolean; driver: string | null }>(
      `SELECT $2::text IS NOT NULL AND $2 = ANY(allowed_tools) AS remembered, permission_mode = 'auto' AS auto, driver_user_id AS driver
         FROM agent_runs WHERE id = $1`, [job.runId, rule])).rows[0];
    const remembered = !!chat?.remembered, automatic = !remembered && !!chat?.auto;
    const allowed = remembered || automatic;
    await tx.query(
      `INSERT INTO agent_permission_requests(id, turn_id, run_id, tool, title, detail, rule, status, remember, automatic, decided_by, decided_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (id) DO NOTHING`,
      [id, job.turnId, job.runId, tool, title, text(input.detail, 4000), rule,
        allowed ? "allowed" : "pending", remembered, automatic, automatic ? chat!.driver : null, allowed ? new Date() : null]);
    const row = (await tx.query<{ status: PermissionStatus; turn_id: string }>(
      `SELECT status, turn_id FROM agent_permission_requests WHERE id = $1`, [id])).rows[0];
    if (row.turn_id !== job.turnId) throw new PermissionError("Invalid permission request.", 409);
    return row.status;
  });
  await signal(job.sessionId, job.runId);
  return status;
}

/** The runner checks whether its request was answered, and whether to remember it. */
export async function permissionStatus(turnId: string, id: string): Promise<{ status: PermissionStatus; remember: boolean } | null> {
  if (!isUuid(id)) return null;
  return queryOne<{ status: PermissionStatus; remember: boolean }>(
    `SELECT status, remember FROM agent_permission_requests WHERE id = $1 AND turn_id = $2`, [id, turnId]);
}

/** The runner stopped waiting (no answer in time, or the turn ended). */
export async function expirePermission(job: AgentRunJob, id: string) {
  if (!isUuid(id)) return;
  const { length } = await query(
    `UPDATE agent_permission_requests SET status = 'expired', decided_at = now()
      WHERE id = $1 AND turn_id = $2 AND status = 'pending' RETURNING id`, [id, job.turnId]);
  if (length) await signal(job.sessionId, job.runId);
}

/** The chat's driver answers. Only they run the agent, on their own computer. */
export async function decidePermission(input: { sessionId: string; runId: string; requestId: string; userId: string; decision: unknown }) {
  const { decision } = input;
  if (decision !== "allow" && decision !== "always" && decision !== "deny") throw new PermissionError("Choose allow, always allow or deny.");
  if (!isUuid(input.runId) || !isUuid(input.requestId)) throw new PermissionError("Request not found.", 404);
  const result = await transaction(async (tx) => {
    const run = (await tx.query<{ driver_user_id: string | null }>(
      `SELECT driver_user_id FROM agent_runs WHERE id = $1 AND session_id = $2 FOR UPDATE`, [input.runId, input.sessionId])).rows[0];
    if (!run) throw new PermissionError("Request not found.", 404);
    if (run.driver_user_id !== input.userId)
      throw new PermissionError("Only the person running this chat can answer: it runs on their computer, with their AI account.", 403);
    const updated = (await tx.query<{ rule: string | null }>(
      `UPDATE agent_permission_requests r SET status = $3, remember = $4, decided_by = $5, decided_at = now()
        FROM agent_turns t
        WHERE r.id = $1 AND r.run_id = $2 AND r.status = 'pending' AND t.id = r.turn_id AND t.status IN ('queued', 'running')
        RETURNING r.rule`,
      [input.requestId, input.runId, decision === "deny" ? "denied" : "allowed", decision === "always", input.userId])).rows[0];
    if (!updated) throw new PermissionError("This request was already answered or the agent stopped waiting.", 409);
    if (decision === "always" && updated.rule)
      await tx.query(`UPDATE agent_runs SET allowed_tools = array_append(allowed_tools, $2) WHERE id = $1 AND NOT ($2 = ANY(allowed_tools))`, [input.runId, updated.rule]);
    return decision === "deny" ? "denied" : "allowed";
  });
  await signal(input.sessionId, input.runId);
  return result;
}

/** A chat's recent requests, newest last; pending ones of a finished turn read as expired. */
export async function listPermissions(runId: string): Promise<PermissionRequest[]> {
  const rows = await query<Row>(
    `SELECT * FROM (
       SELECT r.id, r.turn_id, r.tool, r.title, r.detail, r.rule, r.remember, r.automatic, r.created_at, u.display_name AS decided_by_name,
              CASE WHEN r.status = 'pending' AND t.status NOT IN ('queued', 'running') THEN 'expired' ELSE r.status END AS status
         FROM agent_permission_requests r
         JOIN agent_turns t ON t.id = r.turn_id
         LEFT JOIN users u ON u.id = r.decided_by
        WHERE r.run_id = $1
        ORDER BY r.created_at DESC LIMIT 50) recent
      ORDER BY created_at`, [runId]);
  return rows.map(toRequest);
}

/** Rules this chat always allows, sent to the runner with each turn. */
export async function allowedTools(runId: string): Promise<string[]> {
  return (await queryOne<{ allowed_tools: string[] }>(`SELECT allowed_tools FROM agent_runs WHERE id = $1`, [runId]))?.allowed_tools ?? [];
}

/**
 * The driver switches a chat between Manual ("ask") and Auto. Switching to
 * Auto also allows what the agent is waiting for right now.
 */
export async function setPermissionMode(input: { sessionId: string; runId: string; userId: string; mode: unknown }) {
  if (input.mode !== "ask" && input.mode !== "auto") throw new PermissionError("Choose Manual or Auto.");
  if (!isUuid(input.runId)) throw new PermissionError("Chat not found.", 404);
  const released = await transaction(async (tx) => {
    const run = (await tx.query<{ driver_user_id: string | null }>(
      `SELECT driver_user_id FROM agent_runs WHERE id = $1 AND session_id = $2 FOR UPDATE`, [input.runId, input.sessionId])).rows[0];
    if (!run) throw new PermissionError("Chat not found.", 404);
    if (run.driver_user_id !== input.userId)
      throw new PermissionError("Only the person running this chat can change this: it runs on their computer, with their AI account.", 403);
    await tx.query(`UPDATE agent_runs SET permission_mode = $2 WHERE id = $1`, [input.runId, input.mode]);
    if (input.mode !== "auto") return 0;
    return (await tx.query(
      `UPDATE agent_permission_requests r SET status = 'allowed', automatic = true, decided_by = $2, decided_at = now()
        FROM agent_turns t
        WHERE r.run_id = $1 AND r.status = 'pending' AND t.id = r.turn_id AND t.status IN ('queued', 'running') RETURNING r.id`,
      [input.runId, input.userId])).rows.length;
  });
  await signal(input.sessionId, input.runId);
  return { mode: input.mode, released };
}

/** A new message carries the composer's mode; it applies to the sender's own chat only. */
export async function setRunPermissionMode(runId: string, driverId: string, mode: "ask" | "auto") {
  await query(`UPDATE agent_runs SET permission_mode = $3 WHERE id = $1 AND driver_user_id = $2 AND permission_mode <> $3`, [runId, driverId, mode]);
}
