import { withApiLimit } from "../../../../lib/http/api-limit";
import { issueToken } from "../../../../lib/auth/tokens";
import { completeGoogleAuth } from "../../../../lib/auth/google-store";
import { googleCookie, setGoogleCookie, assertGoogleOrigin, googleErrorResponse } from "../../../../lib/auth/google-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function handlePOST(request: Request) {
  try {
    assertGoogleOrigin(request);
    const input = await request.json();
    if (!input || typeof input !== "object") return Response.json({ error: "Invalid sign-in request." }, { status: 400 });
    const result = await completeGoogleAuth(await googleCookie(), input);
    await issueToken(result.user.id, { userAgent: request.headers.get("user-agent") });
    await setGoogleCookie("");
    return Response.json({ next: result.next });
  } catch (cause) { return googleErrorResponse(cause); }
}
export const POST = withApiLimit("/api/auth/google/complete", handlePOST);
