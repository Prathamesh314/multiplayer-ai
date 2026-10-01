import { conversationAccess, conversationDenied } from "../../../../../lib/chat/auth";
import { events } from "../../../../../lib/events";
import { eventResponse } from "../../../../../lib/events/response";
import { sessionUserResolver } from "../../../../../lib/auth/tokens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Recheck both the login token and conversation access before delivering text. */
export async function GET(
  request: Request,
  context: RouteContext<"/api/chat/conversations/[id]/events">,
) {
  const { id } = await context.params;
  const resolveUser = await sessionUserResolver();
  const result = await conversationAccess(id, resolveUser);
  const refusal = conversationDenied(result);
  if (refusal || !result) return refusal!;

  const bus = await events();
  return eventResponse(request, async send => bus.subscribe(id, send), {
    validate: async () => !!await conversationAccess(id, resolveUser),
    validateEvents: true,
  });
}
