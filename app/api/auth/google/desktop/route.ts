import { withApiLimit } from "../../../../lib/http/api-limit";
import { createGoogleDesktopSignin } from "../../../../lib/auth/google-store";
import { assertGoogleOrigin, googleErrorResponse } from "../../../../lib/auth/google-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function handlePOST(request: Request) {
  try {
    assertGoogleOrigin(request);
    const input = await request.json();
    return Response.json(await createGoogleDesktopSignin(input?.challenge));
  } catch (cause) { return googleErrorResponse(cause); }
}
export const POST = withApiLimit("/api/auth/google/desktop", handlePOST);
