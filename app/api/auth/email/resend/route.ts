import { withApiLimit } from "../../../../lib/http/api-limit";
import { assertEmailOrigin, emailVerificationCookie, emailVerificationErrorResponse } from "../../../../lib/auth/email-http";
import { resendEmailVerification } from "../../../../lib/auth/email-verification";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function handlePOST(request: Request) {
  try {
    assertEmailOrigin(request);
    return Response.json({ verification: await resendEmailVerification(await emailVerificationCookie()) });
  } catch (cause) { return emailVerificationErrorResponse(cause); }
}
export const POST = withApiLimit("/api/auth/email/resend", handlePOST);
