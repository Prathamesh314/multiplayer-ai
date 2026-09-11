import { conversationAccess, conversationDenied } from "../../../../../lib/chat/auth";
import { createMessage, ensureMember, listMessages } from "../../../../../lib/chat/store";
import type { MessagesResponse, SendMessageRequest } from "../../../../../lib/chat/types";
import { events } from "../../../../../lib/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY = 4000;

export async function GET(
  request: Request,
  context: RouteContext<"/api/chat/conversations/[id]/messages">,
) {
  const { id } = await context.params;
  const result = await conversationAccess(id);
  const refusal = conversationDenied(result);
  if (refusal || !result) return refusal!;

  const before = new URL(request.url).searchParams.get("before") ?? undefined;
  const page = await listMessages(id, before);

  return Response.json(page satisfies MessagesResponse, {
    headers: { "cache-control": "no-store" },
  });
}

export async function POST(
  request: Request,
  context: RouteContext<"/api/chat/conversations/[id]/messages">,
) {
  const { id } = await context.params;
  const result = await conversationAccess(id);
  const refusal = conversationDenied(result);
  if (refusal || !result) return refusal!;

  let payload: SendMessageRequest;
  try {
    payload = (await request.json()) as SendMessageRequest;
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const body = typeof payload.body === "string" ? payload.body.trim() : "";
  if (body.length === 0) {
    return Response.json({ error: "Write something first." }, { status: 400 });
  }
  if (body.length > MAX_BODY) {
    return Response.json(
      { error: `Messages are limited to ${MAX_BODY.toLocaleString()} characters.` },
      { status: 413 },
    );
  }

  // Posting to a public channel joins it, so the sender is on the roster and
  // their own message doesn't count as unread.
  await ensureMember(result.conversation.id, result.conversation.orgId, result.user.id);

  const message = await createMessage(id, result.user.id, body);

  // Stored first, then announced — so anyone who reloads after seeing the
  // broadcast finds it in history rather than watching it disappear.
  await (await events()).publish(id, {
    type: "chat.message",
    conversationId: id,
    message,
    at: Date.now(),
  });

  return Response.json(message, { status: 201 });
}
