import { withApiLimit } from "../../../lib/http/api-limit";
import { query } from "../../../lib/db/client";
import { bearerToken, deviceFromToken } from "../../../lib/runner/devices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type RunnerWorkspacesResponse = { userId: string; finishedChats: string[] };

/**
 * The device owner's parallel chats that no longer need a local worktree:
 * merged, discarded or archived, and not running. The runner prunes only
 * when its user asks, and only clean worktrees the server already holds.
 */
async function handlePOST(request: Request) {
  const device = await deviceFromToken(bearerToken(request));
  if (!device) return Response.json({ error: "Unknown or revoked device token." }, { status: 401 });
  const rows = await query<{ id: string }>(
    `SELECT id FROM agent_runs
      WHERE driver_user_id = $1 AND isolation = 'isolated'
        AND (merge_state IN ('merged', 'discarded') OR archived_at IS NOT NULL)
        AND status NOT IN ('running', 'queued')
      ORDER BY ended_at DESC NULLS LAST LIMIT 500`,
    [device.userId],
  );
  return Response.json(
    { userId: device.userId, finishedChats: rows.map(row => row.id) } satisfies RunnerWorkspacesResponse,
    { headers: { "cache-control": "no-store" } },
  );
}

export const POST = withApiLimit("/api/runner/workspaces", handlePOST);
