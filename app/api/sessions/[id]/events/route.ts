import { events } from "../../../../lib/events";
import type { SessionEvent } from "../../../../lib/events";
import { access, denied } from "../../../../lib/session/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Proxies and load balancers close idle streams; a comment resets their timer. */
const KEEPALIVE_MS = 25_000;

/**
 * Server-sent events for one session.
 *
 * SSE rather than WebSockets: the traffic is entirely server-to-client, and
 * `EventSource` reconnects on its own, which a socket would need hand-written
 * backoff to match. Authorisation is checked once here — the stream is opened
 * only for someone already on the roster.
 */
export async function GET(request: Request, context: RouteContext<"/api/sessions/[id]/events">) {
  const { id } = await context.params;
  const result = await access(id);
  const refusal = denied(result);
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

      // Tells EventSource the stream is live and sets its retry backoff.
      send("retry: 3000\n\n");
      send(`event: ready\ndata: ${JSON.stringify({ sessionId: id })}\n\n`);

      unsubscribe = await bus.subscribe(id, (event: SessionEvent) => {
        // A role change aimed at this subscriber: re-authorise live. access()
        // re-derives the current role from the DB, so a demoted-but-present user
        // keeps the stream while a removed/suspended one has it torn down — the
        // read side stops the moment their access does.
        if (event.type === "role.changed" && event.userId === result.user.id) {
          void access(id).then((recheck) => {
            if (!recheck) finish();
          });
        }
        send(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      });

      keepalive = setInterval(() => send(": keepalive\n\n"), KEEPALIVE_MS);
      keepalive.unref?.();

      // Closing the tab aborts the request; without this the subscription and
      // the interval would outlive the reader.
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
      // nginx buffers responses by default, which would hold events until the
      // buffer filled and make the whole thing look broken.
      "x-accel-buffering": "no",
    },
  });
}
