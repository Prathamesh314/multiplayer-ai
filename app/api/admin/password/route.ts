import { withApiLimit } from "../../../lib/http/api-limit";
import { AdminAuthError, adminForToken, adminToken, changePassword, readAdminBody, sameOrigin } from "../../../lib/admin/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handlePOST(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: "Change the password from the admin page." }, { status: 403 });
  const admin = await adminForToken(adminToken(request));
  if (!admin) return Response.json({ error: "Your admin session ended. Sign in again." }, { status: 401 });
  const body = await readAdminBody(request);
  try {
    await changePassword(admin, String(body.current ?? ""), String(body.next ?? ""));
    return Response.json({ ok: true });
  } catch (cause) {
    if (cause instanceof AdminAuthError) return Response.json({ error: cause.message }, { status: cause.status });
    throw cause;
  }
}

export const POST = withApiLimit("/api/admin/password", handlePOST);
