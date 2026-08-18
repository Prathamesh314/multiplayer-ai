import { currentUser } from "../auth/tokens";
import type { CurrentUser } from "../auth/types";
import { getSession } from "./store";
import type { Session, SessionRole } from "./types";

/**
 * Unknown sessions and unauthorised ones get the same 403, so the URL cannot be
 * used to probe which session ids exist.
 */
export function locked(): Response {
  return Response.json(
    {
      error:
        "This session is not open for your account. Ask whoever created it for the share link or the access code.",
    },
    { status: 403, headers: { "cache-control": "no-store" } },
  );
}

export function unauthenticated(): Response {
  return Response.json(
    { error: "Sign in to continue." },
    { status: 401, headers: { "cache-control": "no-store" } },
  );
}

export function forbidden(message: string): Response {
  return Response.json({ error: message }, { status: 403, headers: { "cache-control": "no-store" } });
}

export type Access = { user: CurrentUser; session: Session; role: SessionRole };

/**
 * Resolves the caller against a session's roster.
 *
 * `null` means "not signed in" and `false` means "signed in but not a member" —
 * the two need different responses, because one is fixable by logging in and
 * the other is not.
 */
export async function access(sessionId: string): Promise<Access | null | false> {
  const user = await currentUser();
  if (!user) return null;

  // Resolved with the caller, so `session.myRole` is populated for whatever
  // this route hands back — the client decides what to enable from it.
  const session = await getSession(sessionId, user.id);
  if (!session?.myRole) return false;

  return { user, session, role: session.myRole };
}

/** Turns the three-way result into the right response, or hands back access. */
export function denied(result: Awaited<ReturnType<typeof access>>): Response | null {
  if (result === null) return unauthenticated();
  if (result === false) return locked();
  return null;
}

export const canWrite = (role: SessionRole) => role === "owner" || role === "editor";
