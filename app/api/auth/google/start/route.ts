import { NextResponse } from "next/server";
import { withApiLimit } from "../../../../lib/http/api-limit";
import { beginGoogleAuth } from "../../../../lib/auth/google-store";
import { googleCookie, setGoogleCookie, googleErrorResponse } from "../../../../lib/auth/google-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function handleGET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const flow = await beginGoogleAuth({ next: params.get("next") ?? undefined,
      invitationToken: params.get("invite"), desktopId: params.get("desktop") }, await googleCookie());
    await setGoogleCookie(flow.token);
    return NextResponse.redirect(flow.url, { status: 303, headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" } });
  } catch (cause) { return googleErrorResponse(cause); }
}
export const GET = withApiLimit("/api/auth/google/start", handleGET);
