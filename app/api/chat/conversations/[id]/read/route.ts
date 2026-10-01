import { conversationAccess, conversationDenied } from "../../../../../lib/chat/auth";
import { ensureMember, markRead } from "../../../../../lib/chat/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Advance this account's read cursor to now — called when messages arrive
 *  while the conversation is already open. */
export async function POST(
  _request: Request,
  context: RouteContext<"/api/chat/conversations/[id]/read">,
) {
  const { id } = await context.params;
  const result = await conversationAccess(id);
  const refusal = conversationDenied(result);
  if (refusal || !result) return refusal!;

  if (!await ensureMember(result.conversation.id, result.conversation.orgId, result.user.id)) return conversationDenied(false)!;
  await markRead(id, result.user.id);

  return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
}
