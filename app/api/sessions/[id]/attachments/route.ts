import { withApiLimit } from "../../../../lib/http/api-limit";
import { limitedJson } from "../../../../lib/http/body";
import { access, canWrite, denied, forbidden } from "../../../../lib/session/auth";
import { AttachmentError, createUpload } from "../../../../lib/ai/attachments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

/**
 * Start attaching a file to an AI chat message: checks room access and quota
 * for the declared size, and returns a one-time link the browser streams the
 * bytes to (PUT /api/attachment-uploads). See lib/ai/attachments.ts.
 */
async function handlePOST(request: Request, context: Context) {
  const { id } = await context.params;
  const result = await access(id);
  const refusal = denied(result);
  if (refusal || !result) return refusal!;
  if (!canWrite(result.role)) return forbidden("Only editors can attach files.");
  const body = (await limitedJson(request, 4096).catch(() => null)) as { name?: unknown; size?: unknown; contentType?: unknown } | null;
  if (!body) return Response.json({ error: "Invalid request." }, { status: 400 });
  try {
    const upload = await createUpload({ sessionId: id, userId: result.user.id, name: body.name, size: body.size, contentType: body.contentType });
    return Response.json({ id: upload.id, token: upload.token, uploadUrl: "/api/attachment-uploads" }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof AttachmentError) return Response.json({ error: error.message }, { status: error.status });
    throw error;
  }
}

export const POST = withApiLimit("/api/sessions/[id]/attachments", handlePOST);
