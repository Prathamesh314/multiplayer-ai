import { withApiLimit } from "../../../../lib/http/api-limit";
import { listForkableRuns } from "../../../../lib/ai/memory";
import type { ForkableRun } from "../../../../lib/ai/memory";
import { access, denied } from "../../../../lib/session/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type ForkableRunsResponse = { runs: ForkableRun[] };

/**
 * Candidate source chats for "import context from…" when starting a new chat
 * in this room — every chat in a room the caller can see across the project.
 * Personal sessions (no project) have nothing to offer here.
 */
async function handleGET(_request: Request, context: RouteContext<"/api/sessions/[id]/forkable-runs">) {
  const { id } = await context.params;
  const result = await access(id);
  const refusal = denied(result);
  if (refusal || !result) return refusal!;

  if (!result.session.projectId) {
    return Response.json({ runs: [] } satisfies ForkableRunsResponse, {
      headers: { "cache-control": "no-store" },
    });
  }

  const runs = await listForkableRuns(result.session.projectId, result.user.id);
  return Response.json({ runs } satisfies ForkableRunsResponse, {
    headers: { "cache-control": "no-store" },
  });
}

export const GET = withApiLimit("/api/sessions/[id]/forkable-runs", handleGET);
