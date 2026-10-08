import { auth, clerkClient } from "@clerk/nextjs/server";
import { cookies } from "next/headers";
import { clerkConfigured, ClerkAccountError } from "./clerk-config";
import { recordClerkRevocation, userForClerkSession } from "./clerk-store";
import type { CurrentUser } from "./types";

/** Clerk validates the session; our database supplies workspace permissions. */
export async function currentUser(): Promise<CurrentUser | null> {
  return (await sessionUserResolver())();
}

/** Capture identity in the request context. Streams recheck that exact identity,
 * revocation and JWT expiry without reading another request's cookies. */
export async function sessionUserResolver(): Promise<() => Promise<CurrentUser | null>> {
  if (!clerkConfigured()) return async () => null;
  const { userId, sessionId, sessionClaims } = await auth();
  const expiresAt = Number(sessionClaims?.exp ?? 0) * 1000;
  return async () => userId && sessionId && Date.now() < expiresAt
    ? userForClerkSession(userId, sessionId) : null;
}

export async function revokeToken(): Promise<void> {
  if (clerkConfigured()) {
    const { sessionId } = await auth();
    if (sessionId) {
      await (await clerkClient()).sessions.revokeSession(sessionId);
      await recordClerkRevocation(sessionId);
    }
  }
  (await cookies()).delete("ma_auth");
}

/** Retained only for the retired email migration helper; never mint app sessions. */
export async function issueToken(userId: string, meta?: unknown): Promise<never> {
  void userId; void meta;
  throw new ClerkAccountError("Sign in through Clerk to continue.", 410);
}
