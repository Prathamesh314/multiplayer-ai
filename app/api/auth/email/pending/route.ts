import { withApiLimit } from "../../../../lib/http/api-limit";
import { assertEmailOrigin, emailVerificationCookie, emailVerificationErrorResponse, setEmailVerificationCookie } from "../../../../lib/auth/email-http";
import { cancelEmailVerification } from "../../../../lib/auth/email-verification";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function handleDELETE(request: Request) {
  try {
    assertEmailOrigin(request);
    await cancelEmailVerification(await emailVerificationCookie());
    await setEmailVerificationCookie("");
    return Response.json({ ok: true });
  } catch (cause) { return emailVerificationErrorResponse(cause); }
}
export const DELETE = withApiLimit("/api/auth/email/pending", handleDELETE);
