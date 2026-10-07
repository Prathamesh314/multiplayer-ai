import { cookies } from "next/headers";
import { connectCodeOf } from "../repo/users";
import { EmailVerificationError } from "./email-delivery";
import { startEmailVerification } from "./email-verification";
import { issueToken } from "./tokens";
import type { CurrentUser, PasswordAuthResponse, VerificationRequiredResponse } from "./types";

const cookieName = () => process.env.NODE_ENV === "production" ? "__Host-ma_email" : "ma_email";
export const emailVerificationCookie = async () => (await cookies()).get(cookieName())?.value;
export async function setEmailVerificationCookie(token: string) {
  (await cookies()).set(cookieName(), token, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: token ? 3600 : 0 });
}
export function assertEmailOrigin(request: Request) {
  let origin: string;
  try {
    const url = new URL(process.env.AUTH_PUBLIC_URL || request.url);
    origin = url.origin;
  } catch { throw new EmailVerificationError("Email verification is temporarily unavailable.", 503); }
  if (request.headers.get("origin") !== origin) throw new EmailVerificationError("Open sign-in on this workspace and try again.", 403);
}
export function emailVerificationErrorResponse(cause: unknown) {
  if (cause instanceof SyntaxError) return Response.json({ error: "Expected a valid JSON request." }, { status: 400 });
  if (cause instanceof EmailVerificationError) return Response.json({ error: cause.message, code: cause.code }, {
    status: cause.status, headers: cause.retryAfter ? { "retry-after": String(cause.retryAfter) } : undefined,
  });
  return Response.json({ error: "Email verification is temporarily unavailable. Please try again." }, { status: 503 });
}

/** Every password entry point passes through this gate before issuing a session. */
export async function finishPasswordAuthentication(user: CurrentUser, request: Request, successStatus = 200, legacy = false) {
  try {
    const challenge = await startEmailVerification(user.id, await emailVerificationCookie());
    if (challenge) {
      await setEmailVerificationCookie(challenge.token);
      return Response.json({ status: "verification_required", verification: challenge.verification } satisfies VerificationRequiredResponse, { status: 202 });
    }
    await issueToken(user.id, { userAgent: request.headers.get("user-agent") });
    await setEmailVerificationCookie("");
    const result = { status: "authenticated", user, connectCode: await connectCodeOf(user.id) } satisfies PasswordAuthResponse;
    return Response.json({ ...result, status: legacy ? "existing" : result.status }, { status: successStatus });
  } catch (cause) { return emailVerificationErrorResponse(cause); }
}
