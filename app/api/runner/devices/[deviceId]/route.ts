import { withApiLimit } from "../../../../lib/http/api-limit";
import { currentUser } from "../../../../lib/auth/tokens";
import { revokeDevice } from "../../../../lib/runner/devices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Revoke one of the caller's own devices. Takes effect on the device's next
 * request — every runner call re-resolves the token against an unrevoked row.
 */
async function handleDELETE(
  _request: Request,
  context: RouteContext<"/api/runner/devices/[deviceId]">,
) {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in to continue." }, { status: 401 });

  const { deviceId } = await context.params;
  const revoked = await revokeDevice(deviceId, user.id);
  if (!revoked) {
    return Response.json({ error: "That device isn't yours or is already revoked." }, { status: 404 });
  }
  return Response.json({ ok: true });
}

export const DELETE = withApiLimit("/api/runner/devices/[deviceId]", handleDELETE);
