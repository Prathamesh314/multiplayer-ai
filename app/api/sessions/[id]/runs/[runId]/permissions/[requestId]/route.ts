import { withApiLimit } from "../../../../../../../lib/http/api-limit";
import { runHiddenFrom } from "../../../../../../../lib/ai/runs";
import { limitedJson } from "../../../../../../../lib/http/body";
import { access, canWrite, denied, forbidden } from "../../../../../../../lib/session/auth";
import { PermissionError, decidePermission } from "../../../../../../../lib/ai/permissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string; runId: string; requestId: string }> };

/** The chat's driver allows ("allow" | "always") or denies a tool request. */
async function handlePOST(request: Request, context: Context) {
  const { id, runId, requestId } = await context.params;
  const result = await access(id);
  const refusal = denied(result);
  if (refusal || !result) return refusal!;
  if (await runHiddenFrom(runId, result.user.id)) return Response.json({ error: "Chat not found." }, { status: 404 });
  if (!canWrite(result.role)) return forbidden("You have read-only access to this chat.");
  const body = (await limitedJson(request, 1024).catch(() => null)) as { decision?: unknown } | null;
  try {
    const status = await decidePermission({ sessionId: id, runId, requestId, userId: result.user.id, decision: body?.decision });
    return Response.json({ status });
  } catch (error) {
    if (error instanceof PermissionError) return Response.json({ error: error.message }, { status: error.status });
    throw error;
  }
}

export const POST = withApiLimit("/api/sessions/[id]/runs/[runId]/permissions/[requestId]", handlePOST);
