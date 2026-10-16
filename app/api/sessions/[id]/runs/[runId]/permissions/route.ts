import { withApiLimit } from "../../../../../../lib/http/api-limit";
import { access, denied } from "../../../../../../lib/session/auth";
import { getRun } from "../../../../../../lib/ai/runs";
import { listPermissions, type PermissionRequest } from "../../../../../../lib/ai/permissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string; runId: string }> };
export type PermissionsResponse = { requests: PermissionRequest[] };

/** A chat's recent tool permission requests, for everyone who can see the chat. */
async function handleGET(_request: Request, context: Context) {
  const { id, runId } = await context.params;
  const result = await access(id);
  const refusal = denied(result);
  if (refusal || !result) return refusal!;
  const run = await getRun(runId).catch(() => null);
  if (!run || run.sessionId !== id) return Response.json({ error: "No such run." }, { status: 404 });
  return Response.json({ requests: await listPermissions(runId) } satisfies PermissionsResponse, { headers: { "cache-control": "no-store" } });
}

export const GET = withApiLimit("/api/sessions/[id]/runs/[runId]/permissions", handleGET);
