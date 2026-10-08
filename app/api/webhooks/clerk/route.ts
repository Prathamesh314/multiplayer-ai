import { verifyWebhook } from "@clerk/nextjs/webhooks";
import { NextRequest } from "next/server";
import { limitedText } from "../../../lib/http/body";
import { withApiLimit } from "../../../lib/http/api-limit";
import { deleteClerkAccount, recordClerkRevocation, syncClerkProfile } from "../../../lib/auth/clerk-store";
export const runtime = "nodejs";
export const POST = withApiLimit("/api/webhooks/clerk", async request => {
  if (!process.env.CLERK_WEBHOOK_SIGNING_SECRET) return Response.json({ error: "Webhook is not configured." }, { status: 503 });
  const body = await limitedText(request, 512 * 1024).catch(() => null);
  if (body === null) return Response.json({ error: "Invalid webhook body or size." }, { status: 400 });
  const event = await verifyWebhook(new NextRequest(request.url, { method: "POST", headers: request.headers, body })).catch(() => null);
  if (!event) return Response.json({ error: "Invalid webhook signature." }, { status: 400 });
  switch (event.type) {
    case "user.updated": await syncClerkProfile(event.data); break;
    case "user.deleted": if (event.data.id) await deleteClerkAccount(event.data.id); break;
    case "session.ended": case "session.revoked": case "session.removed": await recordClerkRevocation(event.data.id); break;
  }
  return Response.json({ received: true });
});
