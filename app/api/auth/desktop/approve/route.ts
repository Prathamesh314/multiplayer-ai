import { limitedJson } from "../../../../lib/http/body";
import { withApiLimit } from "../../../../lib/http/api-limit";
import { assertAuthOrigin, requireClerkSession } from "../../../../lib/auth/clerk-http";
import { approveDesktopSignIn } from "../../../../lib/auth/clerk-desktop";
import { userForClerkSession } from "../../../../lib/auth/clerk-store";
import { ClerkAccountError } from "../../../../lib/auth/clerk-config";
export const POST = withApiLimit("/api/auth/desktop/approve", async request => {
  assertAuthOrigin(request);
  const session = await requireClerkSession();
  if (!await userForClerkSession(session.userId, session.sessionId)) throw new ClerkAccountError("Finish setting up your workspace account first.");
  const body = await limitedJson(request, 16 * 1024).catch(() => null) as Record<string, unknown> | null;
  await approveDesktopSignIn(body?.id, session.userId, session.sessionId);
  return Response.json({ approved: true });
});
