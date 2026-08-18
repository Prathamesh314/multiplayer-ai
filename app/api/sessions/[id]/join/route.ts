import { currentUser } from "../../../../lib/auth/tokens";
import {
  addMember,
  getSession,
  joinCodeMatches,
  redeemShareLink,
  roleOf,
} from "../../../../lib/session/store";
import { outranks, type JoinSessionRequest, type SessionRole } from "../../../../lib/session/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Redeems a share link or a typed access code for a place on the roster.
 *
 * Two routes in, granting deliberately different things:
 *
 *   token  a generated link. The role it grants lives in the database, keyed
 *          by the token, so it cannot be raised by editing the URL.
 *   code   the short code that can be read out loud. It is not revocable on
 *          its own, so it always grants the lowest role.
 */
export async function POST(request: Request, context: RouteContext<"/api/sessions/[id]/join">) {
  const { id } = await context.params;

  const user = await currentUser();
  if (!user) {
    return Response.json({ error: "Sign in to open a shared session." }, { status: 401 });
  }

  let body: JoinSessionRequest;
  try {
    body = (await request.json()) as JoinSessionRequest;
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const session = await getSession(id, user.id);
  const hasToken = typeof body.token === "string" && body.token.length > 0;
  const hasCode = typeof body.code === "string" && body.code.trim().length > 0;

  if (!hasToken && !hasCode) {
    return Response.json({ error: "Enter the access code for this session." }, { status: 400 });
  }

  let granted: SessionRole | null = null;

  if (session && hasToken) {
    granted = await redeemShareLink(id, body.token!);
  } else if (session && hasCode) {
    // The typed code is the low-privilege path: it cannot be revoked without
    // disrupting everyone, so it never grants more than read access.
    granted = joinCodeMatches(session, body.code!) ? "viewer" : null;
  }

  // Same response whether the session is missing, the code is wrong, or the
  // link was revoked — none of those should be distinguishable from outside.
  if (!session || !granted) {
    return Response.json(
      { error: "That link or access code is not valid for this session." },
      { status: 403 },
    );
  }

  // Redeeming a viewer link must never demote an existing editor or owner.
  const existing = await roleOf(id, user.id);
  if (!existing || outranks(granted, existing)) {
    await addMember(id, user.id, granted, "share_link", session.ownerId);
  }

  return Response.json((await getSession(id, user.id)) ?? session);
}
