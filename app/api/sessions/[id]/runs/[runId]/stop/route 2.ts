import { withApiLimit } from "../../../../../../lib/http/api-limit";
import { access, denied } from "../../../../../../lib/session/auth";
import { getRun, runHiddenFrom } from "../../../../../../lib/ai/runs";
import { ControlError, isUuid } from "../../../../../../lib/ai/turns";
import { requestStop } from "../../../../../../lib/ai/stop";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Stop the chat's current turn (lib/ai/stop.ts). */
async function handlePOST(_request: Request, context: { params: Promise<{ id: string; runId: string }> }) {
  const { id, runId } = await context.params;
  const result = await access(id), refusal = denied(result);
  if (refusal || !result) return refusal!;
  if (!isUuid(runId)) return Response.json({ error: "Invalid chat ID." }, { status: 400 });
  if (await runHiddenFrom(runId, result.user.id)) return Response.json({ error: "Chat not found." }, { status: 404 });
  const run = await getRun(runId);
  if (!run || run.sessionId !== id) return Response.json({ error: "Chat not found." }, { status: 404 });
  try {
    return Response.json(await requestStop(runId, result.user.id), { status: 202 });
  } catch (error) {
    if (error instanceof ControlError) return Response.json({ error: error.message }, { status: error.status });
    throw error;
  }
}

export const POST = withApiLimit("/api/sessions/[id]/runs/[runId]/stop", handlePOST);
