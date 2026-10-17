import { withApiLimit } from "../../../../../../lib/http/api-limit";
import { access, canWrite, denied, forbidden } from "../../../../../../lib/session/auth";
import { limitedJson } from "../../../../../../lib/http/body";
import { getRun } from "../../../../../../lib/ai/runs";
import { listPermissions, PermissionError, setPermissionMode, type PermissionRequest } from "../../../../../../lib/ai/permissions";

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

/** The driver sets the chat to Manual ({mode:"ask"}) or Auto ({mode:"auto"}); Auto also allows what is waiting. */
async function handlePUT(request: Request, context: Context) {
  const { id, runId } = await context.params;
  const result = await access(id);
  const refusal = denied(result);
  if (refusal || !result) return refusal!;
  if (!canWrite(result.role)) return forbidden("You have read-only access to this chat.");
  const body = (await limitedJson(request, 1024).catch(() => null)) as { mode?: unknown } | null;
  try {
    return Response.json(await setPermissionMode({ sessionId: id, runId, userId: result.user.id, mode: body?.mode }));
  } catch (error) {
    if (error instanceof PermissionError) return Response.json({ error: error.message }, { status: error.status });
    throw error;
  }
}

export const GET = withApiLimit("/api/sessions/[id]/runs/[runId]/permissions", handleGET);
export const PUT = withApiLimit("/api/sessions/[id]/runs/[runId]/permissions", handlePUT);
