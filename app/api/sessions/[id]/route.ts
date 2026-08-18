import { authorize, locked } from "../../../lib/session/auth";
import { revokeSessionKey } from "../../../lib/session/cookie";
import { publicSession, renameSession, setPinned } from "../../../lib/session/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: RouteContext<"/api/sessions/[id]">) {
  const { id } = await context.params;
  const session = await authorize(id);
  if (!session) return locked();

  return Response.json(publicSession(session), { headers: { "cache-control": "no-store" } });
}

export async function PATCH(request: Request, context: RouteContext<"/api/sessions/[id]">) {
  const { id } = await context.params;
  if (!(await authorize(id))) return locked();

  let body: { name?: unknown; pinned?: unknown };
  try {
    body = (await request.json()) as { name?: unknown; pinned?: unknown };
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  // Pinning is the documented escape hatch from retention, so it is settable on
  // its own — renaming must not be a precondition for keeping a session.
  let updated =
    typeof body.pinned === "boolean" ? await setPinned(id, body.pinned) : undefined;

  if (typeof body.name === "string") {
    updated = (await renameSession(id, body.name)) ?? updated;
    if (!updated) {
      return Response.json({ error: "A session name is required." }, { status: 400 });
    }
  }

  if (!updated) {
    return Response.json({ error: "Nothing to update." }, { status: 400 });
  }

  return Response.json(publicSession(updated));
}

/** Leaving only drops this browser's key; the session itself stays alive. */
export async function DELETE(_request: Request, context: RouteContext<"/api/sessions/[id]">) {
  const { id } = await context.params;
  await revokeSessionKey(id);
  return Response.json({ left: true });
}
