import { limitedJson } from "../../../../lib/http/body";
import { clerkClient } from "@clerk/nextjs/server";
import { withApiLimit } from "../../../../lib/http/api-limit";
import { assertAuthOrigin } from "../../../../lib/auth/clerk-http";
import { consumeDesktopSignIn } from "../../../../lib/auth/clerk-desktop";
import { userForClerkSession } from "../../../../lib/auth/clerk-store";
import { clerkConfigured, ClerkAccountError } from "../../../../lib/auth/clerk-config";
export const POST = withApiLimit("/api/auth/desktop/redeem", async request => {
  assertAuthOrigin(request);
  if (!clerkConfigured()) throw new ClerkAccountError("Sign-in is being configured. Please try again shortly.", 503);
  const body = await limitedJson(request, 16 * 1024).catch(() => null) as Record<string, unknown> | null;
  const approval = await consumeDesktopSignIn(body?.id, body?.verifier);
  const client = await clerkClient();
  const session = await client.sessions.getSession(approval.approved_session_id);
  if (session.status !== "active" || session.userId !== approval.clerk_user_id ||
      !await userForClerkSession(approval.clerk_user_id, approval.approved_session_id)) {
    throw new ClerkAccountError("Your browser session ended. Please start sign-in again.", 401);
  }
  const ticket = await client.signInTokens.createSignInToken({ userId: approval.clerk_user_id, expiresInSeconds: 60 });
  return Response.json({ ticket: ticket.token, userId: approval.clerk_user_id }, { headers: { "cache-control": "no-store" } });
});
