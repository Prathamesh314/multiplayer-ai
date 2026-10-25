import { withApiLimit } from "../../../lib/http/api-limit";
import { bearerToken, deviceFromToken } from "../../../lib/runner/devices";
import { events } from "../../../lib/events";
import { eventResponse } from "../../../lib/events/response";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function handleGET(request: Request) {
  const token = bearerToken(request);
  const device = await deviceFromToken(token);
  if (!device) return Response.json({ error: "Unknown or revoked device token." }, { status: 401 });
  const bus = await events();
  const changed = () => bus.publish(`user:${device.userId}`, { type: "devices.changed", at: Date.now() }).catch(() => {});
  await changed();
  return eventResponse(request, async send => {
    const user = await bus.subscribe(`user:${device.userId}`, event => {
      if (event.type === "runner.work" || event.type === "run.inputs" || event.type === "devices.changed" || event.type === "resync") send(event);
    });
    // Terminals this computer hosts for its owner (lib/terminal/remote.ts).
    const own = await bus.subscribe(`device:${device.id}`, event => {
      if (event.type.startsWith("terminal.") || event.type === "run.stop") send(event);
    });
    return async () => { await Promise.all([user(), own()]); };
  }, {
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

export const GET = withApiLimit("/api/runner/events", handleGET);
