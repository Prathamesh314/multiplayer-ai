import { limitedJson } from "../http/body";
import { query } from "../db/client";
import { forbidden, orgDenied, projectAccess } from "../org/auth";
import { canManageProject } from "../project/types";
import { ToolSpecError } from "./agent-tools";

/** The caller's project, and whether they may change its tools. */
export async function projectToolGate(slug: string, projectSlug: string, manage = false) {
  const result = await projectAccess(slug, projectSlug);
  const refusal = orgDenied(result);
  if (refusal || !result) return { response: refusal! };
  const canManage = canManageProject(result.role) && !result.project.archivedAt;
  if (manage && !canManage) return { response: forbidden("Only a manager of an active project can change its AI tools.") };
  return { access: result, canManage };
}

export async function toolInput(request: Request) {
  try {
    const body = await limitedJson(request, 64 * 1024);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body as Record<string, unknown>;
  } catch {
    throw new ToolSpecError("Expected a JSON body.");
  }
}

export function toolFailure(error: unknown) {
  if (error instanceof ToolSpecError) return Response.json({ error: error.message }, { status: /not found/i.test(error.message) ? 404 : 400 });
  console.error("agent tools", error);
  return Response.json({ error: "Could not save the tool. Please try again." }, { status: 503 });
}

/**
 * Which secret names the caller's computers hold (names only; values never
 * leave a computer), so the UI can say what is still missing.
 */
export async function secretsOnComputers(userId: string) {
  const rows = await query<{ name: string }>(
    `SELECT DISTINCT unnest(secret_names) AS name FROM runner_devices WHERE user_id = $1 AND revoked_at IS NULL AND supports_agent_tools`, [userId]);
  return rows.map((row) => row.name).sort();
}

export async function computersSupportTools(userId: string) {
  return (await query(`SELECT 1 FROM runner_devices WHERE user_id = $1 AND revoked_at IS NULL AND supports_agent_tools LIMIT 1`, [userId])).length > 0;
}
