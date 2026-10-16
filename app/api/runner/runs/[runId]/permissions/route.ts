import { withApiLimit } from "../../../../../lib/http/api-limit";
import { limitedJson } from "../../../../../lib/http/body";
import { bearerToken, deviceFromToken } from "../../../../../lib/runner/devices";
import { claimedJob } from "../../../../../lib/runner/jobs";
import { isUuid } from "../../../../../lib/ai/turns";
import { PermissionError, expirePermission, permissionStatus, requestPermission } from "../../../../../lib/ai/permissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ runId: string }> };

async function lease(request: Request, context: Context) {
  const device = await deviceFromToken(bearerToken(request));
  if (!device) return { response: Response.json({ error: "Unknown or revoked device token." }, { status: 401 }) };
  const { runId: turnId } = await context.params;
  if (!isUuid(turnId)) return { response: Response.json({ error: "Invalid turn ID." }, { status: 400 }) };
  const job = await claimedJob(turnId, device.id);
  if (!job) return { response: Response.json({ error: "This device does not own a live execution lease." }, { status: 403 }) };
  return { job };
}

/**
 * The runner asks the chat before its agent uses a tool ({id, tool, title,
 * detail, rule}), or gives up waiting ({id, expire: true}). See lib/ai/permissions.ts.
 */
async function handlePOST(request: Request, context: Context) {
  const { job, response } = await lease(request, context);
  if (!job) return response;
  const body = (await limitedJson(request, 16 * 1024).catch(() => null)) as Record<string, unknown> | null;
  if (!body) return Response.json({ error: "Invalid request." }, { status: 400 });
  try {
    if (body.expire === true) {
      await expirePermission(job, String(body.id ?? ""));
      return Response.json({ status: "expired" });
    }
    return Response.json({ status: await requestPermission(job, body) }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof PermissionError) return Response.json({ error: error.message }, { status: error.status });
    throw error;
  }
}

/** Whether a request was answered: GET ?id=<request id>. */
async function handleGET(request: Request, context: Context) {
  const { job, response } = await lease(request, context);
  if (!job) return response;
  const answer = await permissionStatus(job.turnId, new URL(request.url).searchParams.get("id") ?? "");
  if (!answer) return Response.json({ error: "Request not found." }, { status: 404 });
  return Response.json(answer, { headers: { "cache-control": "no-store" } });
}

export const POST = withApiLimit("/api/runner/runs/[runId]/permissions", handlePOST);
export const GET = withApiLimit("/api/runner/runs/[runId]/permissions", handleGET);
