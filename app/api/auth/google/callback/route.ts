import { withApiLimit } from "../../../../lib/http/api-limit";
import { issueToken } from "../../../../lib/auth/tokens";
import { claimGoogleCallback, finishExistingGoogleAuth, saveGoogleProfile } from "../../../../lib/auth/google-store";
import { exchangeGoogleCode, googleConfig } from "../../../../lib/auth/google-provider";
import { googleCookie, setGoogleCookie, googleRedirect, googleErrorResponse } from "../../../../lib/auth/google-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function handleGET(request: Request) {
  try { googleConfig(); } catch (cause) { return googleErrorResponse(cause); }
  const token = await googleCookie();
  const params = new URL(request.url).searchParams;
  let claimed = false;
  let next = "/workspace";
  let desktopId: string | null = null;
  try {
    const flow = await claimGoogleCallback(token, params.get("state"));
    claimed = true;
    next = flow.return_path;
    desktopId = flow.desktop_id;
    if (params.has("error")) {
      // Keep this browser's consumed flow until expiry so retrying can retain
      // its invitation hash. The state itself can never be claimed again.
      return googleRedirect(`/login?${new URLSearchParams({ google_error: "cancelled", next: flow.return_path, ...(flow.desktop_id ? { desktop: flow.desktop_id } : {}) })}`);
    }
    const code = params.get("code");
    if (!code || code.length > 4096) throw new Error("Missing authorization code");
    const profile = await exchangeGoogleCode(code, flow.code_verifier!, flow.nonce_hash);
    await saveGoogleProfile(token!, profile);
    const existing = await finishExistingGoogleAuth(token!);
    if (existing) {
      await issueToken(existing.user.id, { userAgent: request.headers.get("user-agent") });
      await setGoogleCookie("");
      return googleRedirect(existing.next);
    }
    return googleRedirect("/login?google=complete");
  } catch {
    return googleRedirect(`/login?${new URLSearchParams({ google_error: claimed ? "failed" : "expired", next, ...(desktopId ? { desktop: desktopId } : {}) })}`);
  }
}
export const GET = withApiLimit("/api/auth/google/callback", handleGET);
