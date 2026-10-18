import { withApiLimit } from "../../../../lib/http/api-limit";
import { repositoryContext } from "../../../../lib/session/repository-context";
import { events } from "../../../../lib/events";
import { access, canWrite, denied } from "../../../../lib/session/auth";
import { safeRelativePath } from "../../../../lib/session/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type ActivityRequest = { path: string; line?: number; column?: number; originId?: string };

/**
 * "I am typing in this file."
 *
 * Deliberately does nothing but publish: no database write, no git, no lock.
 * That is what lets it run every couple of seconds while someone types and
 * still arrive in tens of milliseconds, where a save takes over a second.
 *
 * It is fire-and-forget on both sides — losing one changes nothing, because
 * another is along shortly and the badge expires on its own.
 */
async function handlePOST(request: Request, context: RouteContext<"/api/sessions/[id]/activity">) {
  const { id } = await context.params;
  const result = await access(id);
  const refusal = denied(result);
  if (refusal || !result) return refusal!;

  // A viewer cannot change anything, so announcing them as editing would be a
  // lie the UI then has to display.
  if (!canWrite(result.role)) return new Response(null, { status: 204 });

  let body: ActivityRequest;
  try {
    body = (await request.json()) as ActivityRequest;
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const repo = await repositoryContext(result.session, request, result.user.id);
  if (repo instanceof Response) return repo;
  const path = safeRelativePath(body?.path);
  if (!path) return Response.json({ error: "That file path is not valid." }, { status: 400 });

  // Clamped rather than rejected: a caret slightly out of step with the file is
  // a cosmetic marker in the wrong place, never a reason to drop the signal.
  const position = (value: unknown) =>
    Number.isFinite(value) ? Math.min(Math.max(Math.trunc(value as number), 1), 1_000_000) : 1;

  await (await events()).publish(id, {
    type: "file.editing",
    repoId: repo.repoId,
    path,
    line: position(body.line),
    column: position(body.column),
    userId: result.user.id,
    userName: result.user.displayName,
    originId: typeof body.originId === "string" ? body.originId : null,
    at: Date.now(),
  });

  return new Response(null, { status: 204 });
}

export const POST = withApiLimit("/api/sessions/[id]/activity", handlePOST);
