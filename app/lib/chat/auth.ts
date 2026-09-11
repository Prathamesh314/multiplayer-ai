import { currentUser } from "../auth/tokens";
import type { CurrentUser } from "../auth/types";
import { notFound, unauthenticated } from "../org/auth";
import {
  conversationMembership,
  getConversationLite,
  isActiveOrgMember,
  type ConversationLite,
} from "./store";
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
): Promise<ConversationAccess | null | false> {
  const user = await currentUser();
  if (!user) return null;

  const conversation = await getConversationLite(id);
  if (!conversation) return false;

  const membership = await conversationMembership(id, user.id);
  if (membership) return { user, conversation, role: membership.role };

  // A public channel is open to every active member of its org, even before
  // they have explicitly joined it.
  if (conversation.kind === "channel" && conversation.visibility === "public") {
    if (await isActiveOrgMember(conversation.orgId, user.id)) {
      return { user, conversation, role: null };
    }
  }

  return false;
}

/** Turns the three-way result into the right response, or null to proceed. */
export function conversationDenied(
  result: ConversationAccess | null | false,
): Response | null {
  if (result === null) return unauthenticated();
  if (result === false) return notFound();
  return null;
}
