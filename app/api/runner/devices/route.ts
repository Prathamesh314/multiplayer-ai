import { withApiLimit } from "../../../lib/http/api-limit";
import { currentUser } from "../../../lib/auth/tokens";
import { listDevices } from "../../../lib/runner/devices";
import type { RunnerDevice } from "../../../lib/runner/devices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type DevicesResponse = { devices: RunnerDevice[] };

/** The caller's paired computers, newest first, with liveness. */
async function handleGET() {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in to continue." }, { status: 401 });

  return Response.json({ devices: await listDevices(user.id) } satisfies DevicesResponse, {
    headers: { "cache-control": "no-store" },
  });
}

export const GET = withApiLimit("/api/runner/devices", handleGET);
