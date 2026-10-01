import { conversationAccess, conversationDenied } from "../../../../../lib/chat/auth";
import { ChatAccessError, createMessage, listMessages } from "../../../../../lib/chat/store";
import { isUuid } from "../../../../../lib/ai/turns";
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
  if (before !== undefined && !isUuid(before)) return Response.json({ error: "Invalid message cursor." }, { status: 400 });
  const page = await listMessages(id, result.user.id, before);

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

  const body = typeof payload?.body === "string" ? payload.body.trim() : "";
  if (body.length === 0) {
    return Response.json({ error: "Write something first." }, { status: 400 });
  }
  if (body.length > MAX_BODY) {
    return Response.json(
      { error: `Messages are limited to ${MAX_BODY.toLocaleString()} characters.` },
      { status: 413 },
    );
  }

  // Joining, checking current access and writing the message commit together.
  let message;
  try { message = await createMessage(id, result.user.id, body); }
  catch (cause) {
    if (cause instanceof ChatAccessError) return conversationDenied(false)!;
    throw cause;
  }

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
