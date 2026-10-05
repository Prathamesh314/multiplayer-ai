import { withApiLimit } from "../../../lib/http/api-limit";
import { finishPasswordAuthentication } from "../../../lib/auth/email-http";
import type { LoginRequest } from "../../../lib/auth/types";
import { authenticate } from "../../../lib/repo/users";

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

  return finishPasswordAuthentication(user, request);
}

export const POST = withApiLimit("/api/auth/login", handlePOST);
