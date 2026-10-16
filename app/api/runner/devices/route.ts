import { withApiLimit } from "../../../lib/http/api-limit";
import { currentUser } from "../../../lib/auth/tokens";
import { listDevices } from "../../../lib/runner/devices";
import type { RunnerDevice } from "../../../lib/runner/devices";
import { serverExecutionAllowed } from "../../../lib/ai/execution";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type DevicesResponse = { devices: RunnerDevice[]; requiresComputer: boolean };

/** The caller's paired computers, newest first, with liveness. */
async function handleGET(request: Request) {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in to continue." }, { status: 401 });

  return Response.json({ devices: await listDevices(user.id), requiresComputer: !serverExecutionAllowed(request) } satisfies DevicesResponse, {
    headers: { "cache-control": "no-store" },
  });
}

export const GET = withApiLimit("/api/runner/devices", handleGET);
