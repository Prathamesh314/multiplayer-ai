import { withApiLimit } from "../../../lib/http/api-limit";
import { issueToken } from "../../../lib/auth/tokens";
import type { LoginRequest, MeResponse } from "../../../lib/auth/types";
import { authenticate, connectCodeOf } from "../../../lib/repo/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handlePOST(request: Request) {
  let body: LoginRequest;
  try {
    body = (await request.json()) as LoginRequest;
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  if (!body || typeof body.identifier !== "string" || typeof body.password !== "string") {
    return Response.json({ error: "Enter your email and password." }, { status: 400 });
  }

  const user = await authenticate(body.identifier, body.password);
  if (!user) {
    // One message for both failures: saying which half was wrong tells an
    // attacker which accounts exist.
    return Response.json({ error: "That email and password do not match." }, { status: 401 });
  }

  await issueToken(user.id, { userAgent: request.headers.get("user-agent") });

  return Response.json({ user, connectCode: await connectCodeOf(user.id) } satisfies MeResponse);
}

export const POST = withApiLimit("/api/auth/login", handlePOST);
