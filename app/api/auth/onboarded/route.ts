import { withApiLimit } from "../../../lib/http/api-limit";
import { assertAuthOrigin, requireClerkSession } from "../../../lib/auth/clerk-http";
import { markOnboarded, userForClerkSession } from "../../../lib/auth/clerk-store";
import { ClerkAccountError } from "../../../lib/auth/clerk-config";

export const runtime = "nodejs";
/** Records that this account has seen the first-run setup step. */
export const POST = withApiLimit("/api/auth/onboarded", async request => {
  assertAuthOrigin(request);
  const session = await requireClerkSession();
  const user = await userForClerkSession(session.userId, session.sessionId);
  if (!user) throw new ClerkAccountError("Finish setting up your workspace account first.");
  await markOnboarded(user.id);
  return Response.json({ onboarded: true });
});
