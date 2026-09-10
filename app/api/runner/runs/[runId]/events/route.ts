import { events } from "../../../../../lib/events";
import { publishRunEvent } from "../../../../../lib/ai/run-stream";
import type { AiRunEvent } from "../../../../../lib/ai/run-events";
import { bearerToken, deviceFromToken } from "../../../../../lib/runner/devices";
import { claimedJob, renewLease } from "../../../../../lib/runner/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type RunnerEventsRequest = { events: AiRunEvent[] };

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
  const job = await claimedJob(runId, device.id);
  if (!job) return Response.json({ error: "Not your claimed run." }, { status: 404 });

  let body: RunnerEventsRequest;
  try {
    body = (await request.json()) as RunnerEventsRequest;
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  const batch = Array.isArray(body.events) ? body.events : [];
  if (batch.length > MAX_EVENTS_PER_BATCH) {
    return Response.json({ error: "Too many events in one batch." }, { status: 413 });
  }

  const bus = await events();
  for (const event of batch) {
    if (typeof event?.t !== "string" || !ALLOWED.has(event.t)) continue;
    await publishRunEvent(runId, event).catch(() => {});
    if (event.t === "out" || event.t === "err") {
      await bus
        .publish(job.sessionId, {
          type: "run.output",
          runId,
          stream: event.t,
          chunk: event.d,
          at: Date.now(),
        })
        .catch(() => {});
    }
  }

  await renewLease(runId, device.id);
  return Response.json({ ok: true });
}
