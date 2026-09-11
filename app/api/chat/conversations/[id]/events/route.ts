import { conversationAccess, conversationDenied } from "../../../../../lib/chat/auth";
import { events } from "../../../../../lib/events";
import type { SessionEvent } from "../../../../../lib/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Proxies and load balancers close idle streams; a comment resets their timer. */
const KEEPALIVE_MS = 25_000;

/**
 * Server-sent events for one conversation.
 *
 * Same shape as the session event stream: SSE rather than WebSockets because
 * the traffic is entirely server-to-client and `EventSource` reconnects on its
 * own. Authorisation is checked once — the stream opens only for someone who
 * can read the conversation.
 */
export async function GET(
  request: Request,
  context: RouteContext<"/api/chat/conversations/[id]/events">,
) {
  const { id } = await context.params;
  const result = await conversationAccess(id);
  const refusal = conversationDenied(result);
  if (refusal || !result) return refusal!;

  const bus = await events();
  const encoder = new TextEncoder();

  let unsubscribe: (() => Promise<void>) | null = null;
  let keepalive: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (text: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          // The client vanished between the check and the write.
        }
      };

      const finish = () => {
        if (closed) return;
        closed = true;
        if (keepalive) clearInterval(keepalive);
        void unsubscribe?.();
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      };

      send("retry: 3000\n\n");
      send(`event: ready\ndata: ${JSON.stringify({ conversationId: id })}\n\n`);

      unsubscribe = await bus.subscribe(id, (event: SessionEvent) => {
        send(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      });

      keepalive = setInterval(() => send(": keepalive\n\n"), KEEPALIVE_MS);
      keepalive.unref?.();

      request.signal.addEventListener("abort", finish);
      if (request.signal.aborted) finish();
    },

    cancel() {
      closed = true;
      if (keepalive) clearInterval(keepalive);
      void unsubscribe?.();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
