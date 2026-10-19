import { withApiLimit } from "../../../lib/http/api-limit";
import { AdminAuthError, adminCookie, readAdminBody, sameOrigin, signIn } from "../../../lib/admin/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handlePOST(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: "Sign in from the admin page." }, { status: 403 });
  const body = await readAdminBody(request);
  try {
    const session = await signIn(String(body.email ?? ""), String(body.password ?? ""));
    return Response.json({ ok: true, mustChangePassword: session.mustChangePassword }, { headers: { "set-cookie": adminCookie(session.token, session.expiresAt) } });
  } catch (cause) {
    if (cause instanceof AdminAuthError) return Response.json({ error: cause.message }, { status: cause.status });
    throw cause;
  }
}

export const POST = withApiLimit("/api/admin/login", handlePOST);
