import { withApiLimit } from "../../../../../lib/http/api-limit";
import { events } from "../../../../../lib/events";
import { bearerToken, deviceFromToken } from "../../../../../lib/runner/devices";
import { artifactJob } from "../../../../../lib/runner/jobs";
import { saveCheckpoint, validCheckpoint } from "../../../../../lib/runner/checkpoints";
import { limitedJson } from "../../../../../lib/http/body";
import { isUuid } from "../../../../../lib/ai/turns";
export const runtime = "nodejs";
async function handlePOST(request: Request, context: { params: Promise<{ runId: string }> }) {
  const device = await deviceFromToken(bearerToken(request));
  if (!device) return Response.json({ error: "Unknown device." }, { status: 401 });
  const { runId } = await context.params;
  const job = isUuid(runId) ? await artifactJob(runId, device.id) : null;
  if (!job) return Response.json({ error: "Turn not found." }, { status: 404 });
  try {
    const body = await limitedJson(request, 8192);
    if (!validCheckpoint(body)) return Response.json({ error: "Invalid checkpoint." }, { status: 400 });
    await saveCheckpoint(job, device.id, body);
    await (await events()).publish(job.sessionId, { type: "run.activity", runId: job.runId, at: Date.now() }).catch(() => {});
    return Response.json({ acknowledged: body.snapshotSha });
  } catch (cause) { return Response.json({ error: cause instanceof Error ? cause.message : "Checkpoint not saved." }, { status: 409 }); }
}

export const POST = withApiLimit("/api/runner/runs/[runId]/checkpoints", handlePOST);
