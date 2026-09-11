import { conversationAccess, conversationDenied } from "../../../../lib/chat/auth";
import { ensureMember, loadConversation, markRead } from "../../../../lib/chat/store";
import type { ConversationResponse } from "../../../../lib/chat/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The open conversation, with its roster. Opening it also joins a public
 *  channel (so unread tracking starts) and advances the read cursor. */
export async function GET(
  _request: Request,
  context: RouteContext<"/api/chat/conversations/[id]">,
) {
  const { id } = await context.params;
  const result = await conversationAccess(id);
  const refusal = conversationDenied(result);
  if (refusal || !result) return refusal!;

  await ensureMember(result.conversation.id, result.conversation.orgId, result.user.id);
  await markRead(id, result.user.id);

  const conversation = await loadConversation(id, result.user.id);
  if (!conversation) return conversationDenied(false)!;

  return Response.json({ conversation } satisfies ConversationResponse, {
    headers: { "cache-control": "no-store" },
  });
}
