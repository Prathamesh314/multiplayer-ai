import { limitedJson } from "../../../lib/http/body";
import { withApiLimit } from "../../../lib/http/api-limit";
import { assertAuthOrigin } from "../../../lib/auth/clerk-http";
import { clerkConfigured, ClerkAccountError } from "../../../lib/auth/clerk-config";
import { createDesktopSignIn } from "../../../lib/auth/clerk-desktop";
export const POST = withApiLimit("/api/auth/desktop", async request => {
  assertAuthOrigin(request);
  if (!clerkConfigured()) throw new ClerkAccountError("Sign-in is being configured. Please try again shortly.", 503);
  const body = await limitedJson(request, 16 * 1024).catch(() => null) as Record<string, unknown> | null;
  return Response.json(await createDesktopSignIn(body?.challenge));
});
