import { query } from "../../../lib/db/client";
import { localRunnersEnabled } from "../../../lib/runner/jobs";
import { currentUser } from "../../../lib/auth/tokens";
import type { AgentsResponse } from "../../../lib/ai/catalog";
import { detectAgents, invalidateAgentCache } from "../../../lib/ai/detect";
import { terminalAccess } from "../../../lib/terminal/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Which agents this machine has, and whether it will run them.
 *
 * Those are two separate answers on purpose: detection is harmless and always
 * given, so the panel can show what is installed and offer install instructions
 * even on a server that refuses to execute anything.
 */
export async function GET(request: Request) {
  const user = await currentUser();
  if (!user) {
    return Response.json({ error: "Sign in to continue." }, { status: 401 });
  }

  const refresh = new URL(request.url).searchParams.get("refresh") === "1";
  if (refresh) invalidateAgentCache();

  const access = terminalAccess(request);

  const devices = localRunnersEnabled() ? await query<{ agent_ids: string[] }>(
    `SELECT agent_ids FROM runner_devices WHERE user_id = $1 AND revoked_at IS NULL AND version = '2'
      AND last_seen_at > now() - interval '30 seconds'`, [user.id],
  ) : [];
  const localIds = new Set(devices.flatMap(device => device.agent_ids));
  const agents = (await detectAgents(refresh)).map(agent => localIds.has(agent.id)
    ? { ...agent, installed: true, auth: null, execution: "runner" as const }
    : { ...agent, installed: access.allowed && agent.installed });
  return Response.json(
    {
      agents,
      canRun: access.allowed || localIds.size > 0,
      reason: access.allowed || localIds.size > 0 ? null : "Connect your runner with an installed, signed-in agent.",
    } satisfies AgentsResponse,
    { headers: { "cache-control": "no-store" } },
  );
}
