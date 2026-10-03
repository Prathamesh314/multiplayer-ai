import { withApiLimit } from "../../../../../lib/http/api-limit";
import { issueToken } from "../../../../../lib/auth/tokens";
import { redeemGoogleDesktopSignin } from "../../../../../lib/auth/google-store";
import { assertGoogleOrigin, googleErrorResponse } from "../../../../../lib/auth/google-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function handlePOST(request: Request) {
  try {
    assertGoogleOrigin(request);
    const input = await request.json();
    const user = await redeemGoogleDesktopSignin(input?.id, input?.verifier);
    await issueToken(user.id, { userAgent: request.headers.get("user-agent") });
    return Response.json({ ok: true });
  } catch (cause) { return googleErrorResponse(cause); }
}
export const POST = withApiLimit("/api/auth/google/desktop/complete", handlePOST);
