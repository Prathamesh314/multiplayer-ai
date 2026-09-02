import { terminalAccess } from "../../../lib/terminal/guard";
import { destroy, getOrCreate, resize, subscribe, write } from "../../../lib/terminal/pty";
import type { PtyControl } from "../../../lib/terminal/protocol";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Live output of one shell as Server-Sent Events. Bytes are base64-framed so
 * newlines and split UTF-8 sequences survive SSE framing intact. The shell is
 * created on first connect and reaped a short while after the last viewer
 * leaves (see pty.ts). Same RCE gate as the rest of the terminal.
 */
export async function GET(request: Request) {
  const access = terminalAccess(request);
  if (!access.allowed) return Response.json({ error: access.reason }, { status: 403 });

  const url = new URL(request.url);
  const id = url.searchParams.get("id") ?? "";
  if (!id) return Response.json({ error: "An id is required." }, { status: 400 });
  const cols = Number(url.searchParams.get("cols")) || 80;
  const rows = Number(url.searchParams.get("rows")) || 24;

  getOrCreate(id, cols, rows);

  const encoder = new TextEncoder();
  let unsubscribe = () => {};
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let cleanup: (() => void) | null = null;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (text: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          closed = true;
        }
      };
      cleanup = () => {
        if (heartbeat) {
          clearInterval(heartbeat);
          heartbeat = null;
        }
        unsubscribe();
      };

      unsubscribe = subscribe(
        id,
        (chunk) => send(`data: ${Buffer.from(chunk, "utf8").toString("base64")}\n\n`),
        () => {
          send("event: exit\ndata: end\n\n");
          closed = true;
          cleanup?.();
          try {
            controller.close();
          } catch {
            // Already closed.
          }
        },
      );

      // Keeps intermediaries from buffering or closing an otherwise idle stream.
      heartbeat = setInterval(() => send(": ping\n\n"), 25_000);
      heartbeat.unref?.();
    },
    cancel() {
      // The browser went away (tab closed, navigated): stop watching, which
      // starts the shell's grace timer.
      closed = true;
      cleanup?.();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no",
      connection: "keep-alive",
    },
  });
}

/** Keystrokes, resizes, and kills for a shell. */
export async function POST(request: Request) {
  const access = terminalAccess(request);
  if (!access.allowed) return Response.json({ error: access.reason }, { status: 403 });

  let body: PtyControl;
  try {
    body = (await request.json()) as PtyControl;
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const id = typeof body.id === "string" ? body.id : "";
  if (!id) return Response.json({ error: "An id is required." }, { status: 400 });

  switch (body.type) {
    case "input":
      write(id, typeof body.data === "string" ? body.data : "");
      break;
    case "resize":
      resize(id, Number(body.cols) || 80, Number(body.rows) || 24);
      break;
    case "kill":
      destroy(id);
      break;
    default:
      return Response.json({ error: "Unknown control type." }, { status: 400 });
  }

  return new Response(null, { status: 204 });
}
