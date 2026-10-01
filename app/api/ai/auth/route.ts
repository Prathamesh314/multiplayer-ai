import { withApiLimit } from "../../../lib/http/api-limit";
import { spawn } from "node:child_process";
import { agentById, type AgentAuth } from "../../../lib/ai/catalog";
import { authStatus, invalidateAgentCache } from "../../../lib/ai/detect";
import { agentEnv } from "../../../lib/ai/env";
import { currentUser } from "../../../lib/auth/tokens";
import { terminalAccess } from "../../../lib/terminal/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Sign in and out of a coding agent's own account.
 *
 * This does not implement login — it drives the agent's CLI, which owns the
 * whole OAuth flow and stores the token itself (its keychain / config). The app
 * never sees the credential; it just runs `login` / `logout` and reads the
 * resulting status. Reusing the operator's existing subscription login this way
 * is how Conductor stays on a Pro/Max plan instead of per-token API billing.
 *
 * It spawns a CLI on the host — the same class of thing as the terminal and the
 * run route — so it is gated the same way: signed in, and loopback-only in
 * production unless explicitly opted in.
 */
export type AiAuthRequest = {
  agentId: string;
  action: "login" | "logout";
};

/** Frames streamed while a login runs (NDJSON, one per line). */
export type AiAuthEvent =
  | { t: "start" }
  | { t: "out"; d: string }
  | { t: "err"; d: string }
  | { t: "exit"; code: number | null; auth: AgentAuth | null };

/** Logout is quick and unattended, so it answers with the fresh status. */
export type AiAuthResult = { auth: AgentAuth | null };

// A browser OAuth dance is human-paced; give it room but never leave a process
// (and its callback listener) running forever.
const MAX_LOGIN_MS = 5 * 60 * 1000;
const MAX_OUTPUT_BYTES = 256 * 1024;

async function handlePOST(request: Request) {
  if (!(await currentUser())) {
    return Response.json({ error: "Sign in to continue." }, { status: 401 });
  }

  const gate = terminalAccess(request);
  if (!gate.allowed) return Response.json({ error: gate.reason }, { status: 403 });

  let body: AiAuthRequest;
  try {
    body = (await request.json()) as AiAuthRequest;
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const agent = agentById(String(body.agentId ?? ""));
  if (!agent) return Response.json({ error: "Unknown agent." }, { status: 400 });
  if (!agent.auth) {
    return Response.json(
      { error: `${agent.name} manages its own sign-in — there's nothing to do here.` },
      { status: 400 },
    );
  }

  if (body.action === "logout") {
    await runToEnd(agent.bin, agent.auth.logoutArgs);
    invalidateAgentCache();
    const auth = await authStatus(agent);
    return Response.json({ auth } satisfies AiAuthResult, {
      headers: { "cache-control": "no-store" },
    });
  }

  if (body.action === "login") {
    return new Response(loginStream(agent.bin, agent.auth.loginArgs, agent.id), {
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-store, no-transform",
        "x-accel-buffering": "no",
      },
    });
  }

  return Response.json({ error: "Unknown action." }, { status: 400 });
}

/** Runs a short CLI command to completion, ignoring its (informational) output. */
function runToEnd(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, {
        env: { ...agentEnv(), CI: "1", NO_COLOR: "1" },
        stdio: ["ignore", "ignore", "ignore"],
      });
    } catch {
      resolve();
      return;
    }
    child.on("close", () => resolve());
    child.on("error", () => resolve());
  });
}

/**
 * Streams an interactive login. The CLI opens the vendor's browser flow itself
 * and waits for the OAuth callback; we surface its output (the URL, progress)
 * so the operator can follow along, then re-read the status on exit so the UI
 * flips to "signed in" without a second round-trip. stdin is closed — this is
 * the browser handoff, not a TTY prompt; if a CLI ever needs keystrokes here,
 * that is the signal to move this into the pty-backed terminal instead.
 */
function loginStream(bin: string, args: string[], agentId: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let closed = false;
  let bytes = 0;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: AiAuthEvent) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };

      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(bin, args, {
          detached: process.platform !== "win32",
          env: { ...agentEnv(), NO_COLOR: "1" },
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (cause) {
        send({ t: "err", d: cause instanceof Error ? cause.message : String(cause) });
        send({ t: "exit", code: null, auth: null });
        closed = true;
        controller.close();
        return;
      }

      send({ t: "start" });

      const deadline = setTimeout(() => {
        send({ t: "err", d: `Sign-in timed out after ${MAX_LOGIN_MS / 60_000} minutes.\n` });
        try {
          process.kill(-(child.pid ?? 0), "SIGKILL");
        } catch {
          try {
            child.kill("SIGKILL");
          } catch {
            // Already gone.
          }
        }
      }, MAX_LOGIN_MS);
      deadline.unref?.();

      const forward = (stream: NodeJS.ReadableStream | null, kind: "out" | "err") => {
        if (!stream) return;
        stream.setEncoding("utf8");
        stream.on("data", (chunk: string) => {
          if (bytes >= MAX_OUTPUT_BYTES) return;
          bytes += Buffer.byteLength(chunk);
          send({ t: kind, d: chunk });
        });
      };
      forward(child.stdout, "out");
      forward(child.stderr, "err");

      child.on("close", async (code) => {
        clearTimeout(deadline);
        // The login just changed (or didn't) the stored credential; re-read it
        // so the client gets the truth rather than an optimistic guess.
        invalidateAgentCache();
        const agent = agentById(agentId);
        const auth = agent ? await authStatus(agent) : null;
        send({ t: "exit", code, auth });
        closed = true;
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      });

      child.on("error", (cause) => send({ t: "err", d: `${cause.message}\n` }));
    },

    cancel() {
      closed = true;
    },
  });
}

export const POST = withApiLimit("/api/ai/auth", handlePOST);
