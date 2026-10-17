import { withApiLimit } from "../../lib/http/api-limit";
import { AttachmentError, receiveUpload } from "../../lib/ai/attachments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Stream an attachment's bytes to storage, authorised by the one-time token
 * from POST /api/sessions/[id]/attachments. This route is outside the Next
 * proxy (proxy.ts), which would buffer the body and truncate it at 10 MB, so
 * it has no session cookie; the token, bound to one file and size, is the grant.
 */
async function handlePUT(request: Request) {
  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  try {
    const attachment = await receiveUpload(token, request.body);
    return Response.json(attachment, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof AttachmentError) return Response.json({ error: error.message }, { status: error.status });
    throw error;
  }
}

export const PUT = withApiLimit("/api/attachment-uploads", handlePUT);
