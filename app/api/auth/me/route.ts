import { currentUser, revokeToken } from "../../../lib/auth/tokens";
import type { MeResponse } from "../../../lib/auth/types";
import { connectCodeOf, rotateConnectCode } from "../../../lib/repo/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Who the browser is signed in as. Null rather than 401: not being signed in
 *  is a normal answer to this question, not an error. */
export async function GET() {
  const user = await currentUser();
  return Response.json(
    {
      user,
      connectCode: user ? await connectCodeOf(user.id) : null,
    } satisfies MeResponse,
    { headers: { "cache-control": "no-store" } },
  );
}

/** Rotates the connect code, which is how a leaked one is revoked. */
export async function POST() {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in to continue." }, { status: 401 });

  return Response.json({ user, connectCode: await rotateConnectCode(user.id) } satisfies MeResponse);
}

export async function DELETE() {
  await revokeToken();
  return Response.json({ user: null, connectCode: null } satisfies MeResponse);
}
