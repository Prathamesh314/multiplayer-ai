import { currentUser } from "../auth/tokens";
import type { CurrentUser } from "../auth/types";
import { notFound, unauthenticated } from "../org/auth";
import { conversationForUser, type ConversationLite } from "./store";
import type { ConversationRole } from "./types";

/**
 * Route guard for a single conversation, mirroring session/auth.ts and
 * org/auth.ts. Same three-way result: null means "not signed in", false means
 * "signed in but no access" — and unknown and unauthorised look identical so a
 * conversation id can't be probed.
 */
export type ConversationAccess = {
  user: CurrentUser;
  conversation: ConversationLite;
  /** Explicit membership role, or null for a public channel not yet joined. */
  role: ConversationRole | null;
};

export async function conversationAccess(
  id: string,
  resolveUser: () => Promise<CurrentUser | null> = currentUser,
): Promise<ConversationAccess | null | false> {
  const user = await resolveUser();
  if (!user) return null;

  const access = await conversationForUser(id, user.id);
  return access ? { user, ...access } : false;
}

/** Turns the three-way result into the right response, or null to proceed. */
export function conversationDenied(
  result: ConversationAccess | null | false,
): Response | null {
  if (result === null) return unauthenticated();
  if (result === false) return notFound();
  return null;
}
