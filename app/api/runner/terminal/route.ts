import { withApiLimit } from "../../../lib/http/api-limit";
import { bearerToken, deviceFromToken } from "../../../lib/runner/devices";
import { relayFromRunner } from "../../../lib/terminal/remote";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type RunnerTerminalReport =
  | { id: string; output: string }
  | { id: string; exit: number | null }
  | { id: string; notice: string };

/**
 * Output from a terminal on a member's computer. A runner reaches only its own
 * owner's terminal channels, so it can neither read nor write anyone else's.
 */
async function handlePOST(request: Request) {
  const device = await deviceFromToken(bearerToken(request));
  if (!device) return Response.json({ error: "Unknown or revoked device token." }, { status: 401 });
  if (Number(request.headers.get("content-length") ?? 0) > 512 * 1024) return Response.json({ error: "Output batch too large." }, { status: 413 });
  const body = await request.json().catch(() => null) as Partial<Record<string, unknown>> | null;
  const id = typeof body?.id === "string" && /^[A-Za-z0-9-]{1,64}$/.test(body.id) ? body.id : null;
  if (!id) return Response.json({ error: "A valid terminal id is required." }, { status: 400 });
  const at = Date.now();
  if (typeof body?.output === "string" && /^[A-Za-z0-9+/]*={0,2}$/.test(body.output)) {
    await relayFromRunner(device.userId, { type: "terminal.output", id, data: body.output, at });
  } else if (body && "exit" in body && (body.exit === null || Number.isInteger(body.exit))) {
    await relayFromRunner(device.userId, { type: "terminal.exit", id, code: body.exit as number | null, at });
  } else if (typeof body?.notice === "string") {
    await relayFromRunner(device.userId, { type: "terminal.notice", id, message: body.notice.slice(0, 2000), at });
  } else {
    return Response.json({ error: "Expected output, exit or notice." }, { status: 400 });
  }
  return Response.json({ ok: true });
}

export const POST = withApiLimit("/api/runner/terminal", handlePOST);
