import { withApiLimit } from "../../../lib/http/api-limit";
import { currentUser, revokeToken } from "../../../lib/auth/tokens";
import type { MeResponse } from "../../../lib/auth/types";
import { changeHandle, connectCodeOf, HandleError, rotateConnectCode } from "../../../lib/repo/users";
import { limitedJson } from "../../../lib/http/body";
import { assertAuthOrigin } from "../../../lib/auth/clerk-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Who the browser is signed in as. Null rather than 401: not being signed in
 *  is a normal answer to this question, not an error. */
async function handleGET() {
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
async function handlePOST(request: Request) {
  assertAuthOrigin(request);
  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in to continue." }, { status: 401 });

  return Response.json({ user, connectCode: await rotateConnectCode(user.id) } satisfies MeResponse);
}

async function handleDELETE(request: Request) {
  assertAuthOrigin(request);
  await revokeToken();
  return Response.json({ user: null, connectCode: null } satisfies MeResponse);
}

/** Change your @username: `{ handle }`. */
async function handlePATCH(request: Request) {
  assertAuthOrigin(request);
  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in to continue." }, { status: 401 });
  const body = (await limitedJson(request, 1024).catch(() => null)) as { handle?: unknown } | null;
  try {
    const updated = await changeHandle(user.id, body?.handle);
    return Response.json({ user: updated, connectCode: await connectCodeOf(user.id) } satisfies MeResponse);
  } catch (error) {
    if (error instanceof HandleError) return Response.json({ error: error.message }, { status: error.status });
    throw error;
  }
}

export const GET = withApiLimit("/api/auth/me", handleGET);
export const PATCH = withApiLimit("/api/auth/me", handlePATCH);
export const POST = withApiLimit("/api/auth/me", handlePOST);
export const DELETE = withApiLimit("/api/auth/me", handleDELETE);
