import { bearerToken, deviceFromToken } from "../../../lib/runner/devices";
import { claimNextJob } from "../../../lib/runner/jobs";
import type { AgentRunJob } from "../../../lib/ai/run-events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type ClaimRequest = { waitMs?: number };
export type ClaimResponse = { job: AgentRunJob | null; leaseMs: number | null };

/**
 * The runner's work loop: claim the next job addressed to this device's user.
 *
 * Long-poll rather than SSE-push (a deliberate v1 simplification of the plan
 * — docs/local-execution.md §3.3): the request parks up to ~25s and answers
 * the moment a job appears, so delivery latency stays sub-2s while surviving
 * every proxy that mangles server-sent events. The claim itself is atomic in
 * SQL, so several of one user's devices polling at once get one winner each.
 */
const POLL_INTERVAL_MS = 1_500;
const MAX_WAIT_MS = 25_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function POST(request: Request) {
  const device = await deviceFromToken(bearerToken(request));
  if (!device) {
    return Response.json({ error: "Unknown or revoked device token." }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as ClaimRequest;
  const waitMs = Math.max(0, Math.min(Number(body.waitMs ?? 20_000) || 0, MAX_WAIT_MS));
  const deadline = Date.now() + waitMs;

  for (;;) {
    const claimed = await claimNextJob({ userId: device.userId, deviceId: device.id });
    if (claimed) {
      return Response.json(
        { job: claimed.job, leaseMs: claimed.leaseMs } satisfies ClaimResponse,
        { headers: { "cache-control": "no-store" } },
      );
    }
    if (Date.now() >= deadline) {
      return Response.json({ job: null, leaseMs: null } satisfies ClaimResponse, {
        headers: { "cache-control": "no-store" },
      });
    }
    await sleep(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
  }
}
