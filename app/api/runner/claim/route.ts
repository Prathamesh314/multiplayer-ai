import { bearerToken, deviceFromToken } from "../../../lib/runner/devices";
import { claimNextJob } from "../../../lib/runner/jobs";
import { events } from "../../../lib/events";
import { WakeSignal } from "../../../../runner/signals";
import type { AgentRunJob } from "../../../lib/ai/run-events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type ClaimRequest = { waitMs?: number; version?: string };
export type ClaimResponse = { job: AgentRunJob | null; leaseMs: number | null };

/** Claims are durable SQL operations; waiting is driven by pub/sub, not SQL polling. */
const MAX_WAIT_MS = 25_000;

export async function POST(request: Request) {
  const device = await deviceFromToken(bearerToken(request));
  if (!device) {
    return Response.json({ error: "Unknown or revoked device token." }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as ClaimRequest;
  if (body.version !== "2") return Response.json({ error: "Update your runner to protocol 2." }, { status: 426 });
  const waitMs = Math.max(0, Math.min(Number(body.waitMs ?? 20_000) || 0, MAX_WAIT_MS));
  const wake = new WakeSignal();
  const bus = await events();
  const off = await bus.subscribe(`user:${device.userId}`, event => { if (event.type === "runner.work" || event.type === "resync") wake.wake(); });
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), waitMs);
  const stop = () => timeout.abort();
  request.signal.addEventListener("abort", stop, { once: true });
  try {
    for (;;) {
      const version = wake.version();
      const claimed = await claimNextJob({ userId: device.userId, deviceId: device.id });
      if (claimed) return Response.json({ job: claimed.job, leaseMs: claimed.leaseMs } satisfies ClaimResponse, { headers: { "cache-control": "no-store" } });
      if (!waitMs || timeout.signal.aborted || request.signal.aborted) return Response.json({ job: null, leaseMs: null } satisfies ClaimResponse, { headers: { "cache-control": "no-store" } });
      await wake.wait(version, timeout.signal);
      if (timeout.signal.aborted || request.signal.aborted) return Response.json({ job: null, leaseMs: null } satisfies ClaimResponse);
    }
  } finally { clearTimeout(timer); request.signal.removeEventListener("abort", stop); await off(); }
}
