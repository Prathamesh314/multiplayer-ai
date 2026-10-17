import { Readable } from "node:stream";
import { withApiLimit } from "../../../../../../lib/http/api-limit";
import { bearerToken, deviceFromToken } from "../../../../../../lib/runner/devices";
import { claimedJob } from "../../../../../../lib/runner/jobs";
import { isUuid } from "../../../../../../lib/ai/turns";
import { openAttachment } from "../../../../../../lib/ai/attachments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ runId: string; attachmentId: string }> };

/** A runner fetching an attachment of the turn it holds the lease for. */
async function handleGET(request: Request, context: Context) {
  const device = await deviceFromToken(bearerToken(request));
  if (!device) return Response.json({ error: "Unknown or revoked device token." }, { status: 401 });
  const { runId: turnId, attachmentId } = await context.params;
  if (!isUuid(turnId)) return Response.json({ error: "Invalid turn ID." }, { status: 400 });
  const job = await claimedJob(turnId, device.id);
  if (!job) return Response.json({ error: "This device does not own a live execution lease." }, { status: 403 });
  const file = job.attachments?.find((item) => item.id === attachmentId);
  if (!file) return Response.json({ error: "Not an attachment of this turn." }, { status: 404 });
  return new Response(Readable.toWeb(await openAttachment(file.id)) as ReadableStream<Uint8Array>, {
    headers: { "content-type": "application/octet-stream", "content-length": String(file.size), "cache-control": "no-store" },
  });
}

export const GET = withApiLimit("/api/runner/runs/[runId]/attachments/[attachmentId]", handleGET);
