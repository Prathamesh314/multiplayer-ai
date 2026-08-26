import { access, canWrite, denied, forbidden } from "../../../../../../lib/session/auth";
import { getRun, joinRun, leaveRun } from "../../../../../../lib/ai/runs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Watch or co-drive a run. Watching needs only room access; joining as an
 * editor — which lets you send prompts into someone else's run — needs the same
 * write access that starting one does.
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/sessions/[id]/runs/[runId]/join">,
) {
  const { id, runId } = await context.params;
  const result = await access(id);
  const refusal = denied(result);
  if (refusal || !result) return refusal!;

  const run = await getRun(runId);
  if (!run || run.sessionId !== id) {
    return Response.json({ error: "No such run." }, { status: 404 });
  }

  let body: { role?: "editor" | "viewer" } = {};
  try {
    body = (await request.json()) as { role?: "editor" | "viewer" };
  } catch {
    // Defaults to viewer.
  }

  const wantsEditor = body.role === "editor";
  if (wantsEditor && !canWrite(result.role)) {
    return forbidden("You need edit access to co-drive this run.");
  }

  await joinRun(runId, result.user.id, wantsEditor ? "editor" : "viewer");
  return Response.json({ joined: true, role: wantsEditor ? "editor" : "viewer" });
}

/** Stop watching. */
export async function DELETE(
  _request: Request,
  context: RouteContext<"/api/sessions/[id]/runs/[runId]/join">,
) {
  const { id, runId } = await context.params;
  const result = await access(id);
  const refusal = denied(result);
  if (refusal || !result) return refusal!;

  await leaveRun(runId, result.user.id);
  return Response.json({ left: true });
}
