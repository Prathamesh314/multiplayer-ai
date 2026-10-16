import { limitedJson } from "../../../lib/http/body";
import { clerkClient } from "@clerk/nextjs/server";
import { withApiLimit } from "../../../lib/http/api-limit";
import { assertAuthOrigin, requireClerkSession } from "../../../lib/auth/clerk-http";
import { ClerkAccountError } from "../../../lib/auth/clerk-config";
import { completeClerkAccount, hasOnboarded } from "../../../lib/auth/clerk-store";
import { connectCodeOf } from "../../../lib/repo/users";

export const runtime = "nodejs";
export const POST = withApiLimit("/api/auth/complete", async request => {
  assertAuthOrigin(request);
  const session = await requireClerkSession();
  const body = await limitedJson(request, 16 * 1024).catch(() => null) as Record<string, unknown> | null;
  if (!body || (body.invitationToken !== undefined && (typeof body.invitationToken !== "string" || body.invitationToken.length > 512))) {
    return Response.json({ error: "Please check your invitation and try again." }, { status: 400 });
  }
  // Fetch trusted, verified email information before opening any transaction.
  const profile = await (await clerkClient()).users.getUser(session.userId).catch(() => {
    throw new ClerkAccountError("We couldn’t verify your account right now. Please try again.", 503);
  });
  if (!profile.raw) throw new ClerkAccountError("Your account details are temporarily unavailable. Please try again.", 503);
  const clerk = await clerkClient();
  // Only a definite "not found" from Clerk marks an old link as stale.
  const exists = (id: string) => clerk.users.getUser(id).then(() => true, (error: { status?: number }) => (error?.status === 404 ? false : null));
  const user = await completeClerkAccount(profile.raw, body.invitationToken, exists);
  return Response.json({ user, connectCode: await connectCodeOf(user.id), onboarded: await hasOnboarded(user.id) });
});
