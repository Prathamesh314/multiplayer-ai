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
  if (!(await currentUser())) {
    return Response.json({ error: "Sign in to continue." }, { status: 401 });
  }

  const refresh = new URL(request.url).searchParams.get("refresh") === "1";
  if (refresh) invalidateAgentCache();

  const access = terminalAccess(request);

  return Response.json(
    {
      agents: await detectAgents(refresh),
      canRun: access.allowed,
      reason: access.allowed ? null : access.reason,
    } satisfies AgentsResponse,
    { headers: { "cache-control": "no-store" } },
  );
}
