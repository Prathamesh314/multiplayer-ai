import { notifyUsage } from "../../../../../../lib/events/notifications";
import { access, denied } from "../../../../../../lib/session/auth";
import { getRun } from "../../../../../../lib/ai/runs";
import { changeHandoff, handoffState, type HandoffAction } from "../../../../../../lib/ai/handoff";
import { ControlError, isUuid } from "../../../../../../lib/ai/turns";
import { events } from "../../../../../../lib/events";
import { reconcileCompletions } from "../../../../../../lib/ai/finalize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string; runId: string }> };

export async function GET(_request: Request, context: Context) {
  const { id, runId } = await context.params;
  const result = await access(id);
  const refusal = denied(result);
  if (refusal || !result) return refusal!;
  const run = isUuid(runId) ? await getRun(runId) : null;
  if (!run || run.sessionId !== id) return Response.json({ error: "Chat not found." }, { status: 404 });
  await reconcileCompletions(runId);
  return Response.json({ run: await getRun(runId), ...await handoffState(runId, id) }, { headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request, context: Context) {
  const { id, runId } = await context.params;
  const result = await access(id);
  const refusal = denied(result);
  if (refusal || !result) return refusal!;
  const body = await request.json().catch(() => null);
  if (!isUuid(runId) || !body || !Number.isSafeInteger(body.version) || body.version < 0 ||
      !["offer", "accept", "decline", "cancel", "recover"].includes(body.action)) {
    return Response.json({ error: "Expected a valid handoff action and control version." }, { status: 400 });
  }
  if (body.action === "offer") {
    if ((body.toUserId !== null && !isUuid(body.toUserId)) || typeof body.note !== "string" || body.note.length > 1000) {
      return Response.json({ error: "Choose a recipient and a note of at most 1,000 characters." }, { status: 400 });
    }
  } else if (body.action !== "recover" && !isUuid(body.handoffId)) {
    return Response.json({ error: "A valid handoff ID is required." }, { status: 400 });
  }
  try {
    await changeHandoff(runId, id, result.user.id, body as HandoffAction);
    if (body.action === "recover") void notifyUsage(id);
    await events().then(bus => bus.publish(id, { type: "run.control", runId, at: Date.now() })).catch(() => {});
    return GET(request, context);
  } catch (cause) {
    if (cause instanceof ControlError) return Response.json({ error: cause.message }, { status: cause.status });
    throw cause;
  }
}
