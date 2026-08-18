import { events } from "../../../../lib/events";
import { access, denied } from "../../../../lib/session/auth";
import { createMessage, listMessages } from "../../../../lib/session/store";
import type { MessagesResponse, SendMessageRequest } from "../../../../lib/session/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY = 4000;

/**
 * Session chat.
 *
 * Everyone on the roster may post, viewers included: talking about code is not
 * changing it, and a reviewer who can read the files but not ask a question
 * about them is a strange thing to build.
 */
export async function GET(request: Request, context: RouteContext<"/api/sessions/[id]/messages">) {
  const { id } = await context.params;
  const result = await access(id);
  const refusal = denied(result);
  if (refusal || !result) return refusal!;

  // Paging backwards through history: `before` is the oldest id already held.
  const before = new URL(request.url).searchParams.get("before") ?? undefined;
  const page = await listMessages(id, before);

  return Response.json(page satisfies MessagesResponse, {
    headers: { "cache-control": "no-store" },
  });
}

export async function POST(request: Request, context: RouteContext<"/api/sessions/[id]/messages">) {
  const { id } = await context.params;
  const result = await access(id);
  const refusal = denied(result);
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

  const message = await createMessage(id, result.user.id, body);

  // Stored first, then announced — so anyone who reloads after seeing the
  // broadcast finds it in history rather than watching it disappear.
  await (await events()).publish(id, {
    type: "message.created",
    message,
    at: Date.now(),
  });

  return Response.json(message, { status: 201 });
}
