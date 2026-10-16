import { Readable } from "node:stream";
import { withApiLimit } from "../../../../../lib/http/api-limit";
import { access, denied } from "../../../../../lib/session/auth";
import { discardUpload, openAttachment, roomAttachment } from "../../../../../lib/ai/attachments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string; attachmentId: string }> };

/** Raster images can be shown inline; everything else downloads, never renders. */
const INLINE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** Download a file attached to a message in this room. */
async function handleGET(_request: Request, context: Context) {
  const { id, attachmentId } = await context.params;
  const result = await access(id);
  const refusal = denied(result);
  if (refusal || !result) return refusal!;
  const attachment = await roomAttachment(id, attachmentId, result.user.id);
  if (!attachment) return Response.json({ error: "Attachment not found." }, { status: 404 });
  const stream = await openAttachment(attachment.id);
  const inline = INLINE.has(attachment.content_type);
  return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
    headers: {
      "content-type": inline ? attachment.content_type : "application/octet-stream",
      "content-length": attachment.size,
      "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(attachment.name)}`,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cache-control": "private, no-store",
    },
  });
}

/** Remove an unsent upload from the composer. */
async function handleDELETE(_request: Request, context: Context) {
  const { id, attachmentId } = await context.params;
  const result = await access(id);
  const refusal = denied(result);
  if (refusal || !result) return refusal!;
  await discardUpload(id, attachmentId, result.user.id);
  return Response.json({ ok: true });
}

export const GET = withApiLimit("/api/sessions/[id]/attachments/[attachmentId]", handleGET);
export const DELETE = withApiLimit("/api/sessions/[id]/attachments/[attachmentId]", handleDELETE);
