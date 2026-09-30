import { bearerToken, inspectDeviceToken } from "../../../lib/runner/devices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Validate a saved desktop identity without marking a paused runner online. */
export async function GET(request: Request) {
  const device = await inspectDeviceToken(bearerToken(request));
  if (!device) return Response.json({ error: "Unknown or revoked computer." }, { status: 401 });
  return Response.json({ device: { id: device.id, userId: device.userId } }, { headers: { "cache-control": "no-store" } });
}
