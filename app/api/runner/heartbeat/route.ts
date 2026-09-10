import { bearerToken, deviceFromToken } from "../../../lib/runner/devices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type HeartbeatResponse = { ok: true; deviceId: string; serverTime: number };

/**
 * The runner's liveness tick. Resolving the token refreshes `last_seen_at`,
 * which is what makes the device eligible to claim jobs (and what the run
 * route consults for local-first routing). Also the runner's cheapest way to
 * learn it has been revoked: a 401 here means stop and re-pair.
 */
export async function POST(request: Request) {
  const device = await deviceFromToken(bearerToken(request));
  if (!device) {
    return Response.json({ error: "Unknown or revoked device token." }, { status: 401 });
  }
  return Response.json(
    { ok: true, deviceId: device.id, serverTime: Date.now() } satisfies HeartbeatResponse,
    { headers: { "cache-control": "no-store" } },
  );
}
