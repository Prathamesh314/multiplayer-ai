import { passwordProblem } from "../../../lib/auth/password";
import { issueToken } from "../../../lib/auth/tokens";
import type { ContinueRequest, ContinueResponse } from "../../../lib/auth/types";
import { authenticate, connectCodeOf, emailExists } from "../../../lib/repo/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Email-first entry point. One form, two outcomes:
 *
 *   - the email is known  → verify the password and sign in
 *   - the email is new    → check the password is acceptable, then tell the
 *                           client to collect a username (no account yet)
 *
 * The account is created only at the username step (/api/auth/register), so a
 * half-finished signup never leaves a rows behind.
 */
export async function POST(request: Request) {
  let body: ContinueRequest;
  try {
    body = (await request.json()) as ContinueRequest;
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

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
    await issueToken(user.id, { userAgent: request.headers.get("user-agent") });
    return Response.json({
      status: "existing",
      user,
      connectCode: await connectCodeOf(user.id),
    } satisfies ContinueResponse);
  }

  // New email: make sure the password is usable before sending them on to pick
  // a username, so they aren't bounced back after choosing one.
  const problem = passwordProblem(password);
  if (problem) return Response.json({ error: problem, field: "password" }, { status: 400 });

  return Response.json({ status: "new" } satisfies ContinueResponse);
}
