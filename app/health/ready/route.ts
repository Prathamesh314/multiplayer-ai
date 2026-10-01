import { query } from "../../lib/db/client";
import { limitStore } from "../../lib/http/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Internal load-balancer probe, outside /api so it spends no user's allowance.
// The gateway does not expose this path. Never return dependency error details.
export async function GET() {
  try {
    await Promise.all([query("SELECT 1"), limitStore().ready()]);
    return Response.json({ ready: true }, { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ ready: false }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
