import { withApiLimit } from "../../../lib/http/api-limit";
import { sanitizeCatalog } from "../../../lib/ai/model-discovery";
import { query } from "../../../lib/db/client";
import { agentById } from "../../../lib/ai/catalog";
import { bearerToken, deviceFromToken } from "../../../lib/runner/devices";
import { events } from "../../../lib/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type HeartbeatResponse = { ok: true; deviceId: string; serverTime: number };

/**
 * The runner's liveness tick. Resolving the token refreshes `last_seen_at`,
 * which is what makes the device eligible to claim jobs (and what the run
 * route consults for local-first routing). Also the runner's cheapest way to
 * learn it has been revoked: a 401 here means stop and re-pair.
 */
async function handlePOST(request: Request) {
  const device = await deviceFromToken(bearerToken(request));
  if (!device) {
    return Response.json({ error: "Unknown or revoked device token." }, { status: 401 });
  }
  if (Number(request.headers.get("content-length") ?? 0) > 2 * 1024 * 1024) return Response.json({ error: "Inventory too large." }, { status: 413 });
  const body = await request.json().catch(() => null);
  if (body?.version !== "2" || !Array.isArray(body.agentIds)) return Response.json({ error: "Update your runner to protocol 2 and restart it." }, { status: 426 });
  const agentIds = body.agentIds.filter((id: unknown): id is string => typeof id === "string" && !!agentById(id));
  const catalog = sanitizeCatalog(body.modelCatalog);
  const changed = await query(`UPDATE runner_devices SET version = $2, agent_ids = $3, model_catalog = $4, supports_inputs=$5, supports_isolated_chats=$6, supports_terminal=$7 WHERE id = $1
    AND (version IS DISTINCT FROM $2 OR agent_ids IS DISTINCT FROM $3 OR model_catalog IS DISTINCT FROM $4::jsonb OR supports_inputs IS DISTINCT FROM $5 OR supports_isolated_chats IS DISTINCT FROM $6 OR supports_terminal IS DISTINCT FROM $7) RETURNING id`, [device.id, "2", agentIds, JSON.stringify(catalog),body.supportsInputs===true,body.supportsIsolatedChats===true,body.supportsTerminal===true]);
  if(changed.length)await (await events()).publish(`user:${device.userId}`,{type:'devices.changed',at:Date.now()}).catch(()=>{});
  return Response.json(
    { ok: true, deviceId: device.id, serverTime: Date.now() } satisfies HeartbeatResponse,
    { headers: { "cache-control": "no-store" } },
  );
}

export const POST = withApiLimit("/api/runner/heartbeat", handlePOST);
