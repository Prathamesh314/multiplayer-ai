import { signupInvitation, SignupAdmissionError } from "../../../lib/auth/admission";
import { withApiLimit } from "../../../lib/http/api-limit";
import { passwordProblem } from "../../../lib/auth/password";
import { finishPasswordAuthentication } from "../../../lib/auth/email-http";
import type { ContinueRequest, ContinueResponse } from "../../../lib/auth/types";
import { authenticate, emailExists } from "../../../lib/repo/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Compatibility entry point; password login uses the same verification gate. */
async function handlePOST(request: Request) {
  let body: ContinueRequest;
  try {
    body = (await request.json()) as ContinueRequest;
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  if (!body || typeof body !== "object") return Response.json({ error: "Expected account details." }, { status: 400 });

  const email = typeof body.email === "string" ? body.email.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return Response.json({ error: "Enter a valid email address.", field: "email" }, { status: 400 });
  }
  if (!password) {
    return Response.json({ error: "Enter your password.", field: "password" }, { status: 400 });
  }

  if (await emailExists(email)) {
    const user = await authenticate(email, password);
    if (!user) {
      return Response.json({ error: "That password is incorrect.", field: "password" }, { status: 401 });
    }
    return finishPasswordAuthentication(user, request, 200, true);
  }

  // New email: validate the password before registration.
  const problem = passwordProblem(password);
  if (problem) return Response.json({ error: problem, field: "password" }, { status: 400 });

  try { await signupInvitation(email, body.invitationToken); }
  catch (cause) {
    if (cause instanceof SignupAdmissionError) return Response.json({ error: cause.message, field: "invitation" }, { status: 403 });
    throw cause;
  }
  return Response.json({ status: "new" } satisfies ContinueResponse);
}

export const POST = withApiLimit("/api/auth/continue", handlePOST);
