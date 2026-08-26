import { access, denied } from "../../../../lib/session/auth";
import { listRuns } from "../../../../lib/ai/runs";
import type { RunsResponse } from "../../../../lib/ai/runs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Every agent run in this room, newest first. Any member may watch the list. */
export async function GET(_request: Request, context: RouteContext<"/api/sessions/[id]/runs">) {
  const { id } = await context.params;
  const result = await access(id);
  const refusal = denied(result);
  if (refusal || !result) return refusal!;

  const runs = await listRuns(id);
  return Response.json({ runs } satisfies RunsResponse, {
    headers: { "cache-control": "no-store" },
  });
}
