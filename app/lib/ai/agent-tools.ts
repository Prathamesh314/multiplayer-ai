import { createHash } from "node:crypto";
import { query, queryOne } from "../db/client";
import { isUuid } from "./turns";
import { normaliseSpec, secretNames, toolName, ToolSpecError, type RunTool, type ToolKind, type ToolSpec } from "./agent-tools-spec";

/*
 * MCP servers and plugins configured in the app (see agent-tools-spec.ts).
 *
 * A project tool is shared with the project; it runs on a member's computer
 * only after that member approves its exact definition (a changed definition
 * needs approving again). A personal tool belongs to one member, who is its
 * approval. Each run gets the driver's approved project tools plus their own.
 */

export type AgentTool = {
  id: string;
  scope: "project" | "personal";
  kind: ToolKind;
  name: string;
  spec: ToolSpec;
  enabled: boolean;
  /** The viewer approved this exact definition (always true for their personal tools). */
  approved: boolean;
  /** Secrets each computer must hold, by name. */
  secrets: string[];
  createdBy: string | null;
  updatedAt: number;
};
export { ToolSpecError };

const MAX_TOOLS = 30;
type Row = { id: string; project_id: string | null; kind: ToolKind; name: string; spec: ToolSpec; spec_hash: string; enabled: boolean;
  approved_hash: string | null; created_by_name: string | null; updated_at: Date };

/** Bound to what runs: kind, name and definition. */
export function toolHash(kind: ToolKind, name: string, spec: ToolSpec) {
  return createHash("sha256").update(JSON.stringify({ kind, name, spec })).digest("hex");
}

const toTool = (row: Row, viewer: string, personal: boolean): AgentTool => ({
  id: row.id, scope: personal ? "personal" : "project", kind: row.kind, name: row.name, spec: row.spec, enabled: row.enabled,
  approved: personal || row.approved_hash === row.spec_hash, secrets: secretNames(row.spec),
  createdBy: row.created_by_name, updatedAt: row.updated_at.getTime(),
});

const SELECT = `SELECT t.id, t.project_id, t.kind, t.name, t.spec, t.spec_hash, t.enabled, t.updated_at,
  a.spec_hash AS approved_hash, u.display_name AS created_by_name
  FROM agent_tools t LEFT JOIN agent_tool_approvals a ON a.tool_id = t.id AND a.user_id = $2
  LEFT JOIN users u ON u.id = t.created_by`;

export async function listProjectTools(projectId: string, viewer: string) {
  return (await query<Row>(`${SELECT} WHERE t.project_id = $1 ORDER BY t.name`, [projectId, viewer])).map((row) => toTool(row, viewer, false));
}
export async function listPersonalTools(userId: string) {
  return (await query<Row>(`${SELECT} WHERE t.owner_id = $1 ORDER BY t.name`, [userId, userId])).map((row) => toTool(row, userId, true));
}

type Input = { kind?: unknown; name?: unknown; spec?: unknown; enabled?: unknown };
function parse(input: Input) {
  const name = toolName(input.name);
  const { kind, spec } = normaliseSpec(input.kind, input.spec);
  return { name, kind, spec, hash: toolHash(kind, name, spec) };
}
const known = (toolId: string) => { if (!isUuid(toolId)) throw new ToolSpecError("Tool not found."); };
const duplicate = (cause: unknown) => (cause as { code?: string })?.code === "23505";

/** Add a tool to a project (managers) or to a person's own set. */
export async function createTool(scope: { projectId: string } | { ownerId: string }, userId: string, input: Input) {
  const tool = parse(input);
  const projectId = "projectId" in scope ? scope.projectId : null, ownerId = "ownerId" in scope ? scope.ownerId : null;
  const count = await queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM agent_tools WHERE ${projectId ? "project_id" : "owner_id"} = $1`, [projectId ?? ownerId]);
  if ((count?.n ?? 0) >= MAX_TOOLS) throw new ToolSpecError(`Up to ${MAX_TOOLS} tools here.`);
  try {
    const row = await queryOne<{ id: string }>(
      `INSERT INTO agent_tools(project_id, owner_id, kind, name, spec, spec_hash, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [projectId, ownerId, tool.kind, tool.name, JSON.stringify(tool.spec), tool.hash, userId]);
    // Whoever adds a project tool has seen exactly what it runs.
    if (projectId) await query(`INSERT INTO agent_tool_approvals(tool_id, user_id, spec_hash) VALUES ($1,$2,$3)`, [row!.id, userId, tool.hash]);
    return row!.id;
  } catch (cause) {
    if (duplicate(cause)) throw new ToolSpecError(`A tool named ${tool.name} already exists here.`);
    throw cause;
  }
}

/** Change a tool. A changed definition needs everyone's approval again, except its editor's. */
export async function updateTool(scope: { projectId: string } | { ownerId: string }, toolId: string, userId: string, input: Input) {
  known(toolId);
  const where = "projectId" in scope ? "project_id" : "owner_id", owner = "projectId" in scope ? scope.projectId : scope.ownerId;
  if (input.spec === undefined && input.name === undefined && input.kind === undefined) {
    if (typeof input.enabled !== "boolean") throw new ToolSpecError("Nothing to change.");
    const { length } = await query(`UPDATE agent_tools SET enabled = $3, updated_at = now() WHERE id = $1 AND ${where} = $2 RETURNING id`, [toolId, owner, input.enabled]);
    if (!length) throw new ToolSpecError("Tool not found.");
    return;
  }
  const tool = parse(input);
  try {
    const { length } = await query(
      `UPDATE agent_tools SET kind=$3, name=$4, spec=$5, spec_hash=$6, enabled=COALESCE($7, enabled), updated_at=now() WHERE id=$1 AND ${where}=$2 RETURNING id`,
      [toolId, owner, tool.kind, tool.name, JSON.stringify(tool.spec), tool.hash, typeof input.enabled === "boolean" ? input.enabled : null]);
    if (!length) throw new ToolSpecError("Tool not found.");
  } catch (cause) {
    if (duplicate(cause)) throw new ToolSpecError(`A tool named ${tool.name} already exists here.`);
    throw cause;
  }
  if ("projectId" in scope) await approveTool(toolId, userId);
}

export async function deleteTool(scope: { projectId: string } | { ownerId: string }, toolId: string) {
  known(toolId);
  const where = "projectId" in scope ? "project_id" : "owner_id", owner = "projectId" in scope ? scope.projectId : scope.ownerId;
  const { length } = await query(`DELETE FROM agent_tools WHERE id = $1 AND ${where} = $2 RETURNING id`, [toolId, owner]);
  if (!length) throw new ToolSpecError("Tool not found.");
}

/** A member allows a project tool's current definition on their computer. */
export async function approveTool(toolId: string, userId: string) {
  known(toolId);
  const { length } = await query(
    `INSERT INTO agent_tool_approvals(tool_id, user_id, spec_hash) SELECT id, $2, spec_hash FROM agent_tools WHERE id = $1 AND project_id IS NOT NULL
     ON CONFLICT (tool_id, user_id) DO UPDATE SET spec_hash = EXCLUDED.spec_hash, approved_at = now() RETURNING tool_id`, [toolId, userId]);
  if (!length) throw new ToolSpecError("Tool not found.");
}
export async function revokeTool(toolId: string, userId: string) {
  if (!isUuid(toolId)) return;
  await query(`DELETE FROM agent_tool_approvals WHERE tool_id = $1 AND user_id = $2`, [toolId, userId]);
}

/** Is this tool in this project? Approval routes check before acting. */
export async function toolInProject(toolId: string, projectId: string) {
  if (!isUuid(toolId)) return false;
  return !!(await queryOne(`SELECT 1 FROM agent_tools WHERE id = $1 AND project_id = $2`, [toolId, projectId]));
}

/**
 * What a run uses: the driver's enabled personal tools, and the project's
 * enabled tools they approved at their current definition. A personal tool
 * wins a name clash, so a member can override a project server for themselves.
 */
export async function toolsForRun(projectId: string | null, userId: string): Promise<RunTool[]> {
  const rows = await query<Row & { owner_id: string | null }>(
    `SELECT t.id, t.project_id, t.owner_id, t.kind, t.name, t.spec, t.spec_hash, t.enabled, t.updated_at, a.spec_hash AS approved_hash, NULL AS created_by_name
       FROM agent_tools t LEFT JOIN agent_tool_approvals a ON a.tool_id = t.id AND a.user_id = $2
      WHERE t.enabled AND (t.owner_id = $2 OR (t.project_id = $1 AND a.spec_hash = t.spec_hash))
      ORDER BY (t.owner_id IS NULL), t.name`, [projectId, userId]);
  const seen = new Set<string>();
  const tools: RunTool[] = [];
  for (const row of rows) {
    if (seen.has(row.name)) continue;
    seen.add(row.name);
    tools.push({ id: row.id, kind: row.kind, name: row.name, spec: row.spec, hash: row.spec_hash });
  }
  return tools;
}

/** Project tools waiting for this member's approval, for a nudge in the chat. */
export async function pendingToolCount(projectId: string, userId: string) {
  return (await queryOne<{ n: number }>(
    `SELECT count(*)::int AS n FROM agent_tools t LEFT JOIN agent_tool_approvals a ON a.tool_id = t.id AND a.user_id = $2
      WHERE t.project_id = $1 AND t.enabled AND (a.spec_hash IS NULL OR a.spec_hash <> t.spec_hash)`, [projectId, userId]))?.n ?? 0;
}
