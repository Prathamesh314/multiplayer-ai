import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { SignupAdmissionError } from "./admission";
import { authOrigin, GoogleAuthError } from "./google-provider";
import { GOOGLE_FLOW_SECONDS } from "./google-store";

export const googleCookieName = () => process.env.NODE_ENV === "production" ? "__Host-ma_google" : "ma_google";
export const googleCookie = async () => (await cookies()).get(googleCookieName())?.value;
export async function setGoogleCookie(value: string) {
  (await cookies()).set(googleCookieName(), value, {
    httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/",
    maxAge: value ? GOOGLE_FLOW_SECONDS : 0,
  });
}
export function googleRedirect(path: string) {
  const response = NextResponse.redirect(new URL(path, authOrigin()), 303);
  response.headers.set("cache-control", "no-store");
  response.headers.set("referrer-policy", "no-referrer");
  return response;
}
export function assertGoogleOrigin(request: Request) {
  if (request.headers.get("origin") !== authOrigin()) throw new GoogleAuthError("Open sign-in on this workspace and try again.", 403);
}
export function googleErrorResponse(cause: unknown) {
  if (cause instanceof SyntaxError) return Response.json({ error: "Expected a valid JSON request." }, { status: 400 });
  if (cause instanceof GoogleAuthError) return Response.json({ error: cause.message }, { status: cause.status });
  if (cause instanceof SignupAdmissionError) return Response.json({ error: cause.message }, { status: 403 });
  // Provider exceptions may include tokens or authorization codes. Never log or return them.
  return Response.json({ error: "Google sign-in is temporarily unavailable. Please try again." }, { status: 503 });
}
