import { persistActivity, validateActivity } from "../../../../../lib/runner/activity";
import { limitedJson } from "../../../../../lib/http/body";
import { events } from "../../../../../lib/events";
import { publishRunEvent } from "../../../../../lib/ai/run-stream";
import { appendMessage } from "../../../../../lib/ai/runs";
import type { AiRunEvent } from "../../../../../lib/ai/run-events";
import { bearerToken, deviceFromToken } from "../../../../../lib/runner/devices";
import { artifactJob, claimedJob, renewLease } from "../../../../../lib/runner/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type RunnerEventsRequest = { events: AiRunEvent[]; sequence?: number };

/**
 * The runner's up-stream: batched live output from a run executing on the
 * user's machine. Each frame is republished verbatim onto the per-run Redis
 * channel — the same wire the server worker uses — so the driver's browser
 * stream cannot tell where the run executes. Reply/stderr chunks also fan out
 * to the room's event bus for watchers, mirroring the server executor.
 *
 * The runner never sends `exit`: the terminal frame is the server's to emit,
 * after /complete verifies the result. Batches renew the job lease, which is
 * how a healthy long run stays claimed.
 */
const MAX_EVENTS_PER_BATCH = 500;
const ALLOWED = new Set(["start", "out", "think", "act", "err", "notice"]);

export async function POST(request: Request, context: RouteContext<"/api/runner/runs/[runId]/events">) {
  const device = await deviceFromToken(bearerToken(request));
  if (!device) {
    return Response.json({ error: "Unknown or revoked device token." }, { status: 401 });
  }

  const { runId } = await context.params;
  const job = await artifactJob(runId, device.id);
  if (!job) return Response.json({ error: "Not your claimed run." }, { status: 404 });

  let body: RunnerEventsRequest;
  try {
    body = (await limitedJson(request)) as RunnerEventsRequest;
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  if (!validateActivity(body.events)) return Response.json({ error: "Invalid activity events." }, { status: 400 });
  const batch = body.events;
  if (batch.length > MAX_EVENTS_PER_BATCH) {
    return Response.json({ error: "Too many events in one batch." }, { status: 413 });
  }

  let fresh = true;
  if (body.sequence !== undefined) {
    try { fresh = await persistActivity(runId, body.sequence, batch); }
    catch (cause) { return Response.json({ error: cause instanceof Error ? cause.message : "Activity was not saved." }, { status: 409 }); }
  }
  const active = await claimedJob(runId, device.id);
  if (!fresh || !active) return Response.json({ ok: true, acknowledged: body.sequence ?? null });
  const bus = await events();
  for (const event of batch) {
    if (typeof event?.t !== "string" || !ALLOWED.has(event.t)) continue;
    await publishRunEvent(runId, event).catch(() => {});
    if (event.t === "out" || event.t === "err") {
      await bus
        .publish(job.sessionId, {
          type: "run.output",
          runId: job.runId,
          stream: event.t,
          chunk: event.d,
          at: Date.now(),
        })
        .catch(() => {});
    }
    // Warnings survive the stream: persisted exactly like the server
    // executor's own notices, so later readers see why a run went how it did.
    if (event.t === "notice") {
      await appendMessage({ runId: job.runId, role: "system", body: event.message })
        .then((turn) =>
          bus.publish(job.sessionId, {
            type: "run.turn", runId: job.runId, seq: turn.seq, role: "system",
            authorName: null, body: turn.body, at: Date.now(),
          }),
        )
        .catch(() => {});
    }
  }

  await renewLease(runId, device.id);
  return Response.json({ ok: true, acknowledged: body.sequence ?? null });
}
