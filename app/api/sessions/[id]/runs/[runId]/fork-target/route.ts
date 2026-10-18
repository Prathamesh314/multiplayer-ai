import { withApiLimit } from "../../../../../../lib/http/api-limit";
import { access, denied } from "../../../../../../lib/session/auth";
import { getRun, runHiddenFrom } from "../../../../../../lib/ai/runs";
import { isUuid } from "../../../../../../lib/ai/turns";
import { forkTargetFor } from "../../../../../../lib/ai/fork-target";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string; runId: string }> };

/** Where forking this chat starts the new chat (lib/ai/fork-target.ts). */
async function handlePOST(_request: Request, context: Context) {
  const { id, runId } = await context.params;
  const result = await access(id);
  const refusal = denied(result);
  if (refusal || !result) return refusal!;
  if (!isUuid(runId) || await runHiddenFrom(runId, result.user.id)) return Response.json({ error: "Chat not found." }, { status: 404 });
  const run = await getRun(runId);
  if (!run || run.sessionId !== id) return Response.json({ error: "Chat not found." }, { status: 404 });
  return Response.json(await forkTargetFor(result.session, run, result.user));
}

export const POST = withApiLimit("/api/sessions/[id]/runs/[runId]/fork-target", handlePOST);
