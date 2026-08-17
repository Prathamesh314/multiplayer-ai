import { readSessionKeys, revokeSessionKey } from "../../../lib/session/cookie";
import { getSession, keyMatches, publicSession, renameSession } from "../../../lib/session/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Unknown sessions and unauthorised ones get the same 403, so the URL cannot be
 * used to probe which session ids exist.
 */
const LOCKED = Response.json(
  {
    error:
      "This session is not open on this device. Ask whoever created it for the access code — the link on its own does not grant access.",
  },
  { status: 403, headers: { "cache-control": "no-store" } },
);

export async function GET(_request: Request, context: RouteContext<"/api/sessions/[id]">) {
  const { id } = await context.params;
  const session = getSession(id);
  const keys = await readSessionKeys();

  if (!session || !keyMatches(session, keys[id])) return LOCKED.clone();

  return Response.json(publicSession(session), { headers: { "cache-control": "no-store" } });
}

export async function PATCH(request: Request, context: RouteContext<"/api/sessions/[id]">) {
  const { id } = await context.params;
  const session = getSession(id);
  const keys = await readSessionKeys();

  if (!session || !keyMatches(session, keys[id])) return LOCKED.clone();

  let name: unknown;
  try {
    ({ name } = (await request.json()) as { name?: unknown });
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const renamed = typeof name === "string" ? renameSession(id, name) : undefined;
  if (!renamed) return Response.json({ error: "A session name is required." }, { status: 400 });

  return Response.json(publicSession(renamed));
}

/** Leaving only drops this browser's key; the session itself stays alive. */
export async function DELETE(_request: Request, context: RouteContext<"/api/sessions/[id]">) {
  const { id } = await context.params;
  await revokeSessionKey(id);
  return Response.json({ left: true });
}
