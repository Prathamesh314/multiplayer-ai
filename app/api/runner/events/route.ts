import { bearerToken, deviceFromToken } from "../../../lib/runner/devices";
import { events } from "../../../lib/events";
import { eventResponse } from "../../../lib/events/response";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const token = bearerToken(request);
  const device = await deviceFromToken(token);
  if (!device) return Response.json({ error: "Unknown or revoked device token." }, { status: 401 });
  const bus = await events();
  const changed = () => bus.publish(`user:${device.userId}`, { type: "devices.changed", at: Date.now() }).catch(() => {});
  await changed();
  return eventResponse(request, send => bus.subscribe(`user:${device.userId}`, event => {
    if (event.type === "runner.work" || event.type === "run.inputs" || event.type === "devices.changed" || event.type === "resync") send(event);
  }), {
    intervalMs: 15_000,
    validate: async () => {
      if (!await deviceFromToken(token)) return false;
      return true;
    },
    onClose: () => {
      const timer = setTimeout(() => { void changed(); }, 31_000);
      timer.unref?.();
    },
  });
}
