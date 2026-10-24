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
  if (body?.version !== "2" || !Array.isArray(body.agentIds)) {
    // Seen, but too old to take work: shown as "Update needed", not as waiting.
    const version = typeof body?.version === "string" ? body.version.slice(0, 20) : null;
    const seen = await query(`UPDATE runner_devices SET last_seen_at = now(), version = $2 WHERE id = $1 AND (last_seen_at IS NULL OR version IS DISTINCT FROM $2) RETURNING id`, [device.id, version]);
    if (seen.length) await (await events()).publish(`user:${device.userId}`, { type: "devices.changed", at: Date.now() }).catch(() => {});
    return Response.json({ error: "Update your runner to protocol 2 and restart it." }, { status: 426 });
  }
  const agentIds = body.agentIds.filter((id: unknown): id is string => typeof id === "string" && !!agentById(id));
  const catalog = sanitizeCatalog(body.modelCatalog);
  // Installed but signed out: shown in Set up AI with the sign-in command, never given work.
  const signedOutAgentIds = Array.isArray(body.signedOutAgentIds)
    ? [...new Set(body.signedOutAgentIds.filter((id: unknown): id is string => typeof id === "string" && !!agentById(id) && !agentIds.includes(id)))]
    : [];
  // Names of the AI-tool keys this computer holds, never their values.
  const secretNames = Array.isArray(body.secretNames)
    ? [...new Set(body.secretNames.filter((name: unknown): name is string => typeof name === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(name)))].sort().slice(0, 200)
    : [];
  const changed = await query(`UPDATE runner_devices SET version = $2, agent_ids = $3, model_catalog = $4, supports_inputs=$5, supports_isolated_chats=$6, supports_terminal=$7, supports_attachments=$8, supports_agent_tools=$9, secret_names=$10, supports_permissions=$11, signed_out_agent_ids=$12, last_seen_at = now() WHERE id = $1
    AND (last_seen_at IS NULL OR version IS DISTINCT FROM $2 OR agent_ids IS DISTINCT FROM $3 OR model_catalog IS DISTINCT FROM $4::jsonb OR supports_inputs IS DISTINCT FROM $5 OR supports_isolated_chats IS DISTINCT FROM $6 OR supports_terminal IS DISTINCT FROM $7 OR supports_attachments IS DISTINCT FROM $8 OR supports_agent_tools IS DISTINCT FROM $9 OR secret_names IS DISTINCT FROM $10 OR supports_permissions IS DISTINCT FROM $11 OR signed_out_agent_ids IS DISTINCT FROM $12) RETURNING id`, [device.id, "2", agentIds, JSON.stringify(catalog),body.supportsInputs===true,body.supportsIsolatedChats===true,body.supportsTerminal===true,body.supportsAttachments===true,body.supportsAgentTools===true,secretNames,body.supportsPermissions===true,signedOutAgentIds]);
  if(changed.length)await (await events()).publish(`user:${device.userId}`,{type:'devices.changed',at:Date.now()}).catch(()=>{});
  return Response.json(
    { ok: true, deviceId: device.id, serverTime: Date.now() } satisfies HeartbeatResponse,
    { headers: { "cache-control": "no-store" } },
  );
}

export const POST = withApiLimit("/api/runner/heartbeat", handlePOST);
