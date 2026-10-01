import { withApiLimit } from "../../../lib/http/api-limit";
import { passwordProblem } from "../../../lib/auth/password";
import { issueToken } from "../../../lib/auth/tokens";
import type { MeResponse, RegisterRequest } from "../../../lib/auth/types";
import { connectCodeOf, createUser } from "../../../lib/repo/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handlePOST(request: Request) {
  let body: RegisterRequest;
  try {
    body = (await request.json()) as RegisterRequest;
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const problem = passwordProblem(body.password);
  if (problem) return Response.json({ error: problem, field: "password" }, { status: 400 });

  if (typeof body.handle !== "string" || typeof body.email !== "string") {
    return Response.json({ error: "A handle and an email are required." }, { status: 400 });
  }

  const result = await createUser({
    handle: body.handle,
    email: body.email,
    displayName: typeof body.displayName === "string" ? body.displayName : "",
    password: body.password,
  });

  if (!result.ok) {
    return Response.json({ error: result.error, field: result.field }, { status: 409 });
  }

  // Registering signs you in; making people log in again immediately is a
  // step with no purpose.
  await issueToken(result.user.id, {
    userAgent: request.headers.get("user-agent"),
  });

  return Response.json(
    {
      user: result.user,
      connectCode: await connectCodeOf(result.user.id),
    } satisfies MeResponse,
    { status: 201 },
  );
}

export const POST = withApiLimit("/api/auth/register", handlePOST);
