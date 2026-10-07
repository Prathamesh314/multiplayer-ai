import { withApiLimit } from "../../../../lib/http/api-limit";
import { assertEmailOrigin, emailVerificationCookie, emailVerificationErrorResponse, setEmailVerificationCookie } from "../../../../lib/auth/email-http";
import { verifyEmailCode } from "../../../../lib/auth/email-verification";
import { issueToken } from "../../../../lib/auth/tokens";
import { connectCodeOf } from "../../../../lib/repo/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function handlePOST(request: Request) {
  try {
    assertEmailOrigin(request);
    const body = await request.json();
    const user = await verifyEmailCode(await emailVerificationCookie(), body?.code);
    await issueToken(user.id, { userAgent: request.headers.get("user-agent") });
    await setEmailVerificationCookie("");
    return Response.json({ status: "authenticated", user, connectCode: await connectCodeOf(user.id) });
  } catch (cause) { return emailVerificationErrorResponse(cause); }
}
export const POST = withApiLimit("/api/auth/email/verify", handlePOST);
