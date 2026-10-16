import { withApiLimit } from "../../../lib/http/api-limit";
import { currentUser } from "../../../lib/auth/tokens";
import { listDevices } from "../../../lib/runner/devices";
import type { RunnerDevice } from "../../../lib/runner/devices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** `requiresComputer` is always true: AI agents run only on members' computers. Kept for older clients. */
export type DevicesResponse = { devices: RunnerDevice[]; requiresComputer: true };

/** The caller's paired computers, newest first, with liveness. */
async function handleGET() {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in to continue." }, { status: 401 });

  return Response.json({ devices: await listDevices(user.id), requiresComputer: true } satisfies DevicesResponse, {
    headers: { "cache-control": "no-store" },
  });
}

export const GET = withApiLimit("/api/runner/devices", handleGET);
