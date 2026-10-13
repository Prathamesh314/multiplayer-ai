import { withApiLimit } from "../../../../../lib/http/api-limit";
import { reconcileCompletions } from "../../../../../lib/ai/finalize";
import { events } from "../../../../../lib/events";
import { access, denied, forbidden } from "../../../../../lib/session/auth";
import { getRun, listRunMessages, renameRun, setRunArchived } from "../../../../../lib/ai/runs";
import type { RunResponse } from "../../../../../lib/ai/runs";
import { MAX_TITLE } from "../../../../../lib/ai/titles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One run with its full conversation — the replay a watcher gets on open,
 * before subscribing to the live tail. `after` fetches only newer turns.
 */
async function handleGET(
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

  await reconcileCompletions(runId);
  const refreshed = await getRun(runId);
  const after = Number(new URL(request.url).searchParams.get("after") ?? 0);
  const messages = await listRunMessages(runId, Number.isFinite(after) ? after : 0);

  return Response.json({ run: refreshed ?? run, messages } satisfies RunResponse, {
    headers: { "cache-control": "no-store" },
  });
}

/**
 * Rename or archive a run. Both are the starter's call alone — you manage your
 * own chats, not other members'. `{ archived }` archives/restores; `{ title }`
 * renames.
 */
async function handlePATCH(
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
  if (run.driverUserId !== result.user.id || !["owner", "editor"].includes(result.role)) {
    return forbidden("Only the current driver with edit access can manage this chat.");
  }

  const body = (await request.json().catch(() => ({}))) as { title?: unknown; archived?: unknown };

  if (typeof body.archived === "boolean") {
    await setRunArchived(runId, body.archived);
    return Response.json({ ok: true });
  }

  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) {
    return Response.json({ error: "A name is required." }, { status: 400 });
  }

  const named = title.slice(0, MAX_TITLE);
  // Marks the title as the driver's, which also stops any background naming
  // still in flight from overwriting it.
  await renameRun(runId, named);
  await (await events())
    .publish(id, { type: "run.renamed", runId, title: named, at: Date.now() })
    .catch(() => {});
  return Response.json({ ok: true });
}

export const GET = withApiLimit("/api/sessions/[id]/runs/[runId]", handleGET);
export const PATCH = withApiLimit("/api/sessions/[id]/runs/[runId]", handlePATCH);
