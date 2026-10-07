import { withApiLimit } from "../../../lib/http/api-limit";
import { passwordProblem } from "../../../lib/auth/password";
import { finishPasswordAuthentication, emailVerificationErrorResponse } from "../../../lib/auth/email-http";
import { emailDeliveryConfig, emailVerificationEnabled } from "../../../lib/auth/email-delivery";
import type { RegisterRequest } from "../../../lib/auth/types";
import { createUser } from "../../../lib/repo/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handlePOST(request: Request) {
  let body: RegisterRequest;
  try {
    body = (await request.json()) as RegisterRequest;
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  if (!body || typeof body !== "object") return Response.json({ error: "Expected account details." }, { status: 400 });

  const problem = passwordProblem(body.password);
  if (problem) return Response.json({ error: problem, field: "password" }, { status: 400 });

  if (typeof body.email !== "string" || (body.handle !== undefined && typeof body.handle !== "string")) {
    return Response.json({ error: "Enter a valid email address." }, { status: 400 });
  }

  try { if (emailVerificationEnabled()) emailDeliveryConfig(); }
  catch (cause) { return emailVerificationErrorResponse(cause); }

  const result = await createUser({
    invitationToken: typeof body.invitationToken === "string" ? body.invitationToken : undefined,
    handle: body.handle,
    email: body.email,
    displayName: typeof body.displayName === "string" ? body.displayName : "",
    password: body.password,
  });

  if (!result.ok) {
    return Response.json({ error: result.error, field: result.field }, { status: result.field === "invitation" ? 403 : 409 });
  }

  return finishPasswordAuthentication(result.user, request, 201);
}

export const POST = withApiLimit("/api/auth/register", handlePOST);
