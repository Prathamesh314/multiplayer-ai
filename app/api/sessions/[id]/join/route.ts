import { grantSessionKey } from "../../../../lib/session/cookie";
import { getSession, joinCodeMatches, publicSession } from "../../../../lib/session/store";
import type { JoinSessionRequest } from "../../../../lib/session/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Exchanges a join code for this browser's session key. Without the code, a
 * session URL is inert — which is the whole point.
 */
export async function POST(request: Request, context: RouteContext<"/api/sessions/[id]/join">) {
  const { id } = await context.params;

  let code: unknown;
  try {
    ({ code } = (await request.json()) as JoinSessionRequest);
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  if (typeof code !== "string" || code.trim().length === 0) {
    return Response.json({ error: "Enter the access code for this session." }, { status: 400 });
  }

  const session = await getSession(id);
  // Same response whether the session is missing or the code is wrong.
  if (!session || !joinCodeMatches(session, code)) {
    return Response.json(
      { error: "That session id and access code do not match." },
      { status: 403 },
    );
  }

  await grantSessionKey(session.id, session.key);
  return Response.json(publicSession(session));
}
