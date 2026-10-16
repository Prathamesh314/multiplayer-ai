import { withApiLimit } from "../../../lib/http/api-limit";
import { terminalUser } from "../../../lib/terminal/guard";
import { destroy, getOrCreate, resize, subscribe, write } from "../../../lib/terminal/pty";
import type { PtyControl } from "../../../lib/terminal/protocol";
import { currentUser } from "../../../lib/auth/tokens";
import { computerTerminals, controlRemote, openRemote, pickTerminalDevice, terminalContext } from "../../../lib/terminal/remote";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Live output of one shell as Server-Sent Events. Bytes are base64-framed so
 * newlines and split UTF-8 sequences survive SSE framing intact. The shell is
 * created on first connect and reaped a short while after the last viewer
 * leaves (see pty.ts). Same RCE gate as the rest of the terminal.
 */
async function handleGET(request: Request) {
  if (computerTerminals()) return computerStream(request);
  const caller = await terminalUser(request);
  if ("refusal" in caller) return caller.refusal;

  const url = new URL(request.url);
  const id = url.searchParams.get("id") ?? "";
  if (!id) return Response.json({ error: "An id is required." }, { status: 400 });
  const cols = Number(url.searchParams.get("cols")) || 80;
  const rows = Number(url.searchParams.get("rows")) || 24;

  const started = getOrCreate(id, cols, rows, caller.user.id);
  if (!started.ok) return Response.json({ error: started.reason }, { status: started.status });

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
        caller.user.id,
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

const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-store, no-transform",
  "x-accel-buffering": "no",
  connection: "keep-alive",
};

/**
 * A terminal on the member's own computer: opened (or reattached) there by
 * their runner in the chat's worktree, with output relayed back here. The
 * frames are the same as a server shell's, plus `notice` lines to show.
 */
async function computerStream(request: Request) {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in to use the terminal." }, { status: 401 });
  const url = new URL(request.url);
  const id = url.searchParams.get("id") ?? "";
  if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) return Response.json({ error: "A valid id is required." }, { status: 400 });
  const cols = Math.min(Math.max(Number(url.searchParams.get("cols")) || 80, 10), 500);
  const rows = Math.min(Math.max(Number(url.searchParams.get("rows")) || 24, 5), 200);
  const context = await terminalContext(user.id, url.searchParams);
  if ("error" in context) return Response.json({ error: context.error }, { status: context.status });
  const device = await pickTerminalDevice(user.id, context.runId);

  const encoder = new TextEncoder();
  let closed = false;
  let detach: (() => Promise<void>) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (text: string) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(text)); } catch { closed = true; }
      };
      const end = () => {
        if (closed) return;
        send("event: exit\ndata: end\n\n");
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        void detach?.();
        try { controller.close(); } catch { /* already closed */ }
      };
      const notice = (message: string) => send(`event: notice\ndata: ${JSON.stringify(message)}\n\n`);
      if (!device) {
        notice("Terminals open on your computer, in your chat's worktree. Open the desktop app or start the runner on your computer, then open a new terminal.");
        end();
        return;
      }
      try {
        detach = await openRemote({ id, userId: user.id, device, cols, rows, context, onEvent: event => {
          if (event.type === "terminal.output") send(`data: ${event.data}\n\n`);
          else if (event.type === "terminal.notice") notice(event.message);
          else end();
        } });
      } catch (cause) {
        notice(cause instanceof Error ? cause.message : "The terminal could not be opened.");
        end();
        return;
      }
      heartbeat = setInterval(() => send(": ping\n\n"), 25_000);
      heartbeat.unref?.();
    },
    cancel() {
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      void detach?.();
    },
  });
  return new Response(stream, { headers: SSE_HEADERS });
}

/** Keystrokes, resizes, and kills for a shell. */
async function handlePOST(request: Request) {
  let body: PtyControl;
  try {
    body = (await request.json()) as PtyControl;
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const id = typeof body.id === "string" ? body.id : "";
  if (!id) return Response.json({ error: "An id is required." }, { status: 400 });

  if (computerTerminals()) {
    const user = await currentUser();
    if (!user) return Response.json({ error: "Sign in to use the terminal." }, { status: 401 });
    const control = body.type === "input" ? { type: "input" as const, data: typeof body.data === "string" ? body.data.slice(0, 65_536) : "" }
      : body.type === "resize" ? { type: "resize" as const, cols: Math.min(Math.max(Number(body.cols) || 80, 10), 500), rows: Math.min(Math.max(Number(body.rows) || 24, 5), 200) }
      : body.type === "kill" ? { type: "kill" as const } : null;
    if (!control) return Response.json({ error: "Unknown control type." }, { status: 400 });
    // An unknown id (not yet open, or someone else's) is ignored, like a server shell's.
    await controlRemote(id, user.id, control);
    return new Response(null, { status: 204 });
  }

  const caller = await terminalUser(request);
  if ("refusal" in caller) return caller.refusal;

  switch (body.type) {
    case "input":
      write(id, caller.user.id, typeof body.data === "string" ? body.data : "");
      break;
    case "resize":
      resize(id, caller.user.id, Number(body.cols) || 80, Number(body.rows) || 24);
      break;
    case "kill":
      destroy(id, caller.user.id);
      break;
    default:
      return Response.json({ error: "Unknown control type." }, { status: 400 });
  }

  return new Response(null, { status: 204 });
}

export const GET = withApiLimit("/api/terminal/pty", handleGET);
export const POST = withApiLimit("/api/terminal/pty", handlePOST);
