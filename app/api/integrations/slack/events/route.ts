import { withApiLimit } from "../../../../lib/http/api-limit";
import {
  verifySlack,
  slackEvent,
} from "../../../../lib/integrations/slack-events";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function handlePOST(request: Request) {
  if (!request.body) return new Response(null, { status: 400 });
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 256 * 1024) {
        await reader.cancel();
        return new Response(null, { status: 413 });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (
    !verifySlack(
      raw,
      request.headers.get("x-slack-request-timestamp") ?? "",
      request.headers.get("x-slack-signature") ?? "",
    )
  )
    return new Response(null, { status: 401 });
  try {
    const data = JSON.parse(raw);
    if (data.type === "url_verification" && typeof data.challenge === "string")
      return Response.json({ challenge: data.challenge });
    await slackEvent(data);
    return Response.json({ ok: true });
  } catch {
    return new Response(null, { status: 503 });
  }
}
export const POST = withApiLimit("/api/integrations/slack/events", handlePOST);
