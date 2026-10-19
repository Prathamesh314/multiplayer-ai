import { withApiLimit } from "../../../lib/http/api-limit";
import { adminForToken, adminToken, clearedAdminCookie, sameOrigin, signOut } from "../../../lib/admin/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handlePOST(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: "Sign out from the admin page." }, { status: 403 });
  const admin = await adminForToken(adminToken(request));
  if (admin) await signOut(admin);
  return Response.json({ ok: true }, { headers: { "set-cookie": clearedAdminCookie() } });
}

export const POST = withApiLimit("/api/admin/logout", handlePOST);
