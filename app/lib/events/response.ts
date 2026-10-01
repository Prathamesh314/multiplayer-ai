import type { SessionEvent } from "./types";

/** Bounded SSE with race-safe cancellation and periodic authorization checks. */
export function eventResponse(request: Request, subscribe: (send: (event: SessionEvent) => void, close: () => void) => Promise<() => Promise<void>>, options: {
  validate?: () => Promise<boolean>; intervalMs?: number; onClose?: () => void;
  /** Revalidate immediately before content-bearing frames; bounded to avoid a DB backlog. */
  validateEvents?: boolean;
} = {}) {
  const encoder = new TextEncoder();
  let closed = false, checking = false;
  let unsubscribe: (() => Promise<void>) | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let delivery = Promise.resolve();
  let pending = 0;
  let finish = () => {};
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      finish = () => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        request.signal.removeEventListener("abort", finish);
        void unsubscribe?.().catch(() => {});
        options.onClose?.();
        try { controller.close(); } catch { /* already closed */ }
      };
      const send = (text: string) => {
        if (closed) return;
        if ((controller.desiredSize ?? 0) <= 0) { finish(); return; }
        try { controller.enqueue(encoder.encode(text)); } catch { finish(); }
      };
      request.signal.addEventListener("abort", finish, { once: true });
      if (request.signal.aborted) { finish(); return; }
      try {
        const off = await subscribe(event => {
          const frame = () => send(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
          if (!options.validateEvents) { frame(); return; }
          if (closed) return;
          if (++pending > 64) { finish(); return; }
          delivery = delivery.then(async () => {
            if (closed) return;
            if (options.validate && !await options.validate()) { finish(); return; }
            frame();
          }).catch(finish).finally(() => { pending--; });
        }, finish);
        if (closed) { await off(); return; }
        unsubscribe = off;
        send('retry: 3000\nevent: ready\ndata: {}\n\n');
        timer = setInterval(() => {
          if (checking || closed) return;
          checking = true;
          void (async () => {
            if (options.validate && !await options.validate()) { finish(); return; }
            send(": keepalive\n\n");
          })().catch(finish).finally(() => { checking = false; });
        }, options.intervalMs ?? 25_000);
        timer.unref?.();
      } catch { finish(); }
    },
    cancel() { finish(); },
  }, { highWaterMark: 256 * 1024, size: chunk => chunk.byteLength });
  return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store, no-transform", connection: "keep-alive", "x-accel-buffering": "no" } });
}
