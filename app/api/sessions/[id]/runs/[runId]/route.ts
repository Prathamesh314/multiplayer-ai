import { access, denied, forbidden } from "../../../../../lib/session/auth";
import { getRun, listRunMessages, renameRun } from "../../../../../lib/ai/runs";
import type { RunResponse } from "../../../../../lib/ai/runs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_TITLE = 200;

/**
 * One run with its full conversation — the replay a watcher gets on open,
 * before subscribing to the live tail. `after` fetches only newer turns.
 */
export async function GET(
  request: Request,
  context: RouteContext<"/api/sessions/[id]/runs/[runId]">,
) {
  const { id, runId } = await context.params;
  const result = await access(id);
  const refusal = denied(result);
  if (refusal || !result) return refusal!;

  const run = await getRun(runId);
  // A run id from another room must not be readable through this room's grant.
  if (!run || run.sessionId !== id) {
    return Response.json({ error: "No such run." }, { status: 404 });
  }

  const after = Number(new URL(request.url).searchParams.get("after") ?? 0);
  const messages = await listRunMessages(runId, Number.isFinite(after) ? after : 0);

  return Response.json({ run, messages } satisfies RunResponse, {
    headers: { "cache-control": "no-store" },
  });
}

/** Rename a run. Only the person who started it may rename it. */
export async function PATCH(
  request: Request,
  context: RouteContext<"/api/sessions/[id]/runs/[runId]">,
) {
  const { id, runId } = await context.params;
  const result = await access(id);
  const refusal = denied(result);
  if (refusal || !result) return refusal!;

  const run = await getRun(runId);
  if (!run || run.sessionId !== id) {
    return Response.json({ error: "No such run." }, { status: 404 });
  }
  if (run.startedBy !== result.user.id) {
    return forbidden("Only the person who started a run can rename it.");
  }

  const body = (await request.json().catch(() => ({}))) as { title?: unknown };
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) {
    return Response.json({ error: "A name is required." }, { status: 400 });
  }

  await renameRun(runId, title.slice(0, MAX_TITLE));
  return Response.json({ ok: true });
}
