import { spawn } from "node:child_process";
import { agentById } from "../../../lib/ai/catalog";
import { events } from "../../../lib/events";
import { access, canWrite, denied, forbidden } from "../../../lib/session/auth";
import { workPath } from "../../../lib/session/paths";
import { commitWork, ensureWork, withRepoLock } from "../../../lib/session/repo";
import { setHeadSha } from "../../../lib/session/store";
import { terminalAccess } from "../../../lib/terminal/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_RUN_MS = 10 * 60 * 1000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_PROMPT = 20_000;

export type AiRunRequest = { sessionId: string; agentId: string; prompt: string };

export type AiRunEvent =
  | { t: "start"; agent: string; cwd: string }
  | { t: "out"; d: string }
  | { t: "err"; d: string }
  | { t: "notice"; message: string }
  | { t: "exit"; code: number | null; ms: number; headSha: string | null; committed: boolean };

/**
 * Runs a coding agent against the session's working copy.
 *
 * This is remote code execution with an LLM holding the keyboard, so it is
 * gated exactly like the terminal — same guard, same reasons — and additionally
 * requires write access to the session, because these tools edit files.
 *
 * The prompt is passed as an argv element, never through a shell, so no amount
 * of quoting in it can become a second command.
 */
export async function POST(request: Request) {
  let body: AiRunRequest;
  try {
    body = (await request.json()) as AiRunRequest;
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const result = await access(String(body.sessionId ?? ""));
  const refusal = denied(result);
  if (refusal || !result) return refusal!;

  if (!canWrite(result.role)) {
    return forbidden("Running an agent changes files, which needs edit access.");
  }
  if (!result.session.repo) {
    return Response.json({ error: "This session has no repository yet." }, { status: 404 });
  }

  const gate = terminalAccess(request);
  if (!gate.allowed) return Response.json({ error: gate.reason }, { status: 403 });

  const agent = agentById(String(body.agentId ?? ""));
  if (!agent) return Response.json({ error: "Unknown agent." }, { status: 400 });

  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) return Response.json({ error: "Write a prompt first." }, { status: 400 });
  if (prompt.length > MAX_PROMPT) {
    return Response.json({ error: "That prompt is too long." }, { status: 413 });
  }

  const sessionId = result.session.id;
  const headSha = result.session.repo.headSha;
  await withRepoLock(sessionId, () => ensureWork(sessionId, headSha));

  const author = { name: result.user.displayName, email: result.user.email };
  return new Response(runStream(sessionId, agent.bin, agent.promptArgs(prompt), author), {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no",
    },
  });
}

function runStream(
  sessionId: string,
  bin: string,
  args: string[],
  author: { name: string; email: string },
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const cwd = workPath(sessionId);
  const startedAt = Date.now();

  let closed = false;
  let bytes = 0;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: AiRunEvent) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };

      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(bin, args, {
          cwd,
          detached: process.platform !== "win32",
          env: { ...agentEnv(), CI: "1", NO_COLOR: "1" },
          // stdin closed: these run in one-shot mode and must never sit
          // waiting on input nobody can supply.
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (cause) {
        send({ t: "err", d: cause instanceof Error ? cause.message : String(cause) });
        send({ t: "exit", code: null, ms: 0, headSha: null, committed: false });
        closed = true;
        controller.close();
        return;
      }

      send({ t: "start", agent: bin, cwd });

      const deadline = setTimeout(() => {
        send({ t: "notice", message: `Stopped after ${MAX_RUN_MS / 60_000} minutes.` });
        kill(child);
      }, MAX_RUN_MS);
      deadline.unref?.();

      const forward = (stream: NodeJS.ReadableStream | null, kind: "out" | "err") => {
        if (!stream) return;
        stream.setEncoding("utf8");
        stream.on("data", (chunk: string) => {
          if (bytes >= MAX_OUTPUT_BYTES) return;
          bytes += Buffer.byteLength(chunk);
          send({ t: kind, d: chunk });
          if (bytes >= MAX_OUTPUT_BYTES) {
            send({ t: "notice", message: "Output limit reached — the run was stopped." });
            kill(child);
          }
        });
      };

      forward(child.stdout, "out");
      forward(child.stderr, "err");

      child.on("close", async (code) => {
        clearTimeout(deadline);

        // Whatever it changed is committed here, so the session keeps its
        // "never uncommitted" invariant and everyone else sees the result.
        let sha: string | null = null;
        try {
          sha = await withRepoLock(sessionId, () =>
            commitWork(sessionId, `${bin}: agent run`, author.name, author.email),
          );
          if (sha) {
            await setHeadSha(sessionId, sha);
            await (await events()).publish(sessionId, {
              type: "file.saved",
              path: "",
              headSha: sha,
              authorId: "agent",
              authorName: `${author.name} · ${bin}`,
              originId: null,
              at: Date.now(),
            });
          }
        } catch (cause) {
          send({ t: "err", d: `Could not commit the changes: ${String(cause)}\n` });
        }

        send({
          t: "exit",
          code,
          ms: Date.now() - startedAt,
          headSha: sha,
          committed: sha !== null,
        });
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

/**
 * The environment the agent gets.
 *
 * Markers left by whatever launched this server are stripped: a server started
 * from a shell inside Claude Code inherits CLAUDECODE=1, and the agent then
 * refuses to start because it believes it is being nested. It is not — this is
 * a separate process spawned by a server — so the stale marker is dropped
 * rather than the check bypassed.
 *
 * Credentials are deliberately left alone: the agent authenticates the same way
 * it does when the operator runs it by hand.
 */
function agentEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key === "CLAUDECODE" || key.startsWith("CLAUDE_CODE_")) delete env[key];
  }
  return env;
}

/** Targets the process group so a helper the agent spawned dies with it. */
function kill(child: ReturnType<typeof spawn>): void {
  try {
    process.kill(-(child.pid ?? 0), "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
}
