import { auth } from "@clerk/nextjs/server";
import { publicOrigin } from "../http/public-origin";
import { ClerkAccountError, clerkConfigured } from "./clerk-config";
import { queryOne } from "../db/client";

export function assertAuthOrigin(request: Request) {
  if (request.headers.get("origin") !== publicOrigin(request)) {
    throw new ClerkAccountError("Please sign in from the application website.");
  }
}

export async function requireClerkSession() {
  if (!clerkConfigured()) throw new ClerkAccountError("Sign-in is being configured. Please try again shortly.", 503);
  const session = await auth();
  if (!session.userId || !session.sessionId) throw new ClerkAccountError("Please sign in to continue.", 401);
  if (await queryOne("SELECT 1 FROM clerk_revoked_sessions WHERE session_id=$1", [session.sessionId])) {
    throw new ClerkAccountError("Your session ended. Please sign in again.", 401);
  }
  return { userId: session.userId, sessionId: session.sessionId };
}

export async function retiredAuth() {
  return Response.json({ error: "Sign-in has moved to Clerk. Open the sign-in page to continue.", signInUrl: "/login" },
    { status: 410, headers: { "cache-control": "no-store" } });
}
