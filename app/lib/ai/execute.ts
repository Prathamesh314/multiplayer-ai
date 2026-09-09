import { spawn } from "node:child_process";
import { events } from "../events";
import { commitWork, diffStat, ensureWork, withRepoLock } from "../session/repo";
import { workPath } from "../session/paths";
import { setHeadSha } from "../session/store";
import { agentById } from "./catalog";
import { agentEnv } from "./env";
import { appendMessage, finishRun } from "./runs";
import { ingestExchange } from "./shared-memory";
import type { AgentRunJob, AiRunEvent } from "./run-events";

/**
 * Runs one agent turn end to end, against the session's working copy.
 *
 * This is the execution core lifted out of the run route so that the two ways a
 * turn can run — inline in the web process (no Redis) and inside a worker
 * (Redis) — share *exactly* the same code. Nothing about spawning, committing,
 * or persisting differs between them; only where the live events go, which is
 * the injected `onEvent`. The route feeds them to the driver's response; the
 * worker publishes them to Redis for the route to forward. Everything else —
 * the durable turn, the auto-commit, the watcher broadcasts, the memory ingest
 * — happens here, once.
 *
 * The caller has already created the run row and stored the user's prompt turn;
 * this picks up from there and always ends by calling `finishRun`.
 *
 * This is remote code execution with an LLM at the keyboard, gated upstream
 * exactly like the terminal. The prompt reaches the CLI only as an argv value
 * (never a shell string), so no quoting inside it can become a second command.
 */
const MAX_RUN_MS = 10 * 60 * 1000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
/** Thinking is streamed for feedback but never stored, and capped separately so
 * a long chain of thought cannot crowd out the reply's budget. */
const MAX_THINK_BYTES = 256 * 1024;

export function executeAgentRun(
  job: AgentRunJob,
  onEvent: (event: AiRunEvent) => void,
): Promise<void> {
  const { sessionId, runId, baseSha, author, userPrompt } = job;

  const broadcast = (event: Parameters<Awaited<ReturnType<typeof events>>["publish"]>[1]) => {
    void events().then((bus) => bus.publish(sessionId, event)).catch(() => {});
  };

  const failFast = async (message: string): Promise<void> => {
    onEvent({ t: "err", d: message });
    onEvent({ t: "exit", code: null, ms: 0, headSha: null, committed: false });
    await finishRun(runId, { status: "failed", error: message }).catch(() => {});
    broadcast({ type: "run.finished", runId, status: "failed", headSha: null, at: Date.now() });
  };

  return new Promise<void>((resolve) => {
    void (async () => {
      const agent = agentById(job.agentId);
      if (!agent) {
        await failFast("Unknown agent.");
        resolve();
        return;
      }

      const bin = agent.bin;
      const args = agent.promptArgs(job.agentPrompt, { model: job.model, effort: job.effort });
      const parser = agent.createStreamParser?.() ?? null;

      // Materialize the working copy at the run's base before spawning. A cold
      // clone would otherwise stall the first event, so it happens here rather
      // than upstream, and a failure fails the run cleanly.
      try {
        await withRepoLock(sessionId, () => ensureWork(sessionId, baseSha));
      } catch (cause) {
        await failFast(
          `Could not prepare the workspace: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
        resolve();
        return;
      }

      const cwd = workPath(sessionId);
      const startedAt = Date.now();
      let closed = false;
      let bytes = 0;
      let thinkBytes = 0;
      let outBuf = "";
      let errBuf = "";

      const send = (event: AiRunEvent) => {
        if (closed) return;
        onEvent(event);
      };

      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(bin, args, {
          cwd,
          detached: process.platform !== "win32",
          env: { ...agentEnv(), CI: "1", NO_COLOR: "1" },
          // stdin closed: these run one-shot and must never sit waiting on
          // input nobody can supply.
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (cause) {
        await failFast(cause instanceof Error ? cause.message : String(cause));
        resolve();
        return;
      }

      send({ t: "start", agent: bin, cwd, runId });

      const deadline = setTimeout(() => {
        send({ t: "notice", message: `Stopped after ${MAX_RUN_MS / 60_000} minutes.` });
        kill(child);
      }, MAX_RUN_MS);
      deadline.unref?.();

      // The reply: shown live, accumulated for storage, and broadcast to
      // watchers. The only durable output.
      const emitReply = (text: string) => {
        if (bytes >= MAX_OUTPUT_BYTES) return;
        bytes += Buffer.byteLength(text);
        send({ t: "out", d: text });
        outBuf += text;
        broadcast({ type: "run.output", runId, stream: "out", chunk: text, at: Date.now() });
        if (bytes >= MAX_OUTPUT_BYTES) {
          send({ t: "notice", message: "Output limit reached — the run was stopped." });
          kill(child);
        }
      };

      // Thinking and tool activity: live "it's working" feedback, never stored,
      // sharing one budget so a long chain of thought cannot starve the reply's.
      const emitThinking = (text: string) => {
        if (thinkBytes >= MAX_THINK_BYTES) return;
        thinkBytes += Buffer.byteLength(text);
        send({ t: "think", d: text });
      };
      const emitActivity = (text: string) => {
        if (thinkBytes >= MAX_THINK_BYTES) return;
        thinkBytes += Buffer.byteLength(text);
        send({ t: "act", d: text });
      };

      const emitErr = (chunk: string) => {
        if (bytes >= MAX_OUTPUT_BYTES) return;
        bytes += Buffer.byteLength(chunk);
        send({ t: "err", d: chunk });
        errBuf += chunk;
        broadcast({ type: "run.output", runId, stream: "err", chunk, at: Date.now() });
        if (bytes >= MAX_OUTPUT_BYTES) {
          send({ t: "notice", message: "Output limit reached — the run was stopped." });
          kill(child);
        }
      };

      // stdout is either JSON events to decode (parser set) or the reply
      // verbatim. JSON is newline-delimited, so it is buffered into whole lines;
      // a trailing partial line is left for the next chunk.
      let lineBuf = "";
      const onStdout = (chunk: string) => {
        if (!parser) {
          emitReply(chunk);
          return;
        }
        lineBuf += chunk;
        let newline;
        while ((newline = lineBuf.indexOf("\n")) >= 0) {
          const line = lineBuf.slice(0, newline);
          lineBuf = lineBuf.slice(newline + 1);
          for (const piece of parser.push(line)) {
            if (piece.kind === "reply") emitReply(piece.text);
            else if (piece.kind === "thinking") emitThinking(piece.text);
            else emitActivity(piece.text);
          }
        }
      };

      if (child.stdout) {
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", onStdout);
      }
      if (child.stderr) {
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", emitErr);
      }

      child.on("close", async (code) => {
        clearTimeout(deadline);

        // Whatever it changed is committed here, keeping the session's "never
        // uncommitted" invariant and letting everyone else see the result.
        let sha: string | null = null;
        try {
          sha = await withRepoLock(sessionId, () =>
            commitWork(sessionId, `${bin}: agent run`, author.name, author.email),
          );
          if (sha) {
            await setHeadSha(sessionId, sha);
            broadcast({
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

        // Persist the output as one consolidated turn, then close the run out.
        // Errors here must not break the live stream, so they are swallowed.
        try {
          const trimmedOut = outBuf.trim();
          if (trimmedOut) {
            const turn = await appendMessage({ runId, role: "agent", body: trimmedOut });
            broadcast({
              type: "run.turn", runId, seq: turn.seq, role: "agent",
              authorName: null, body: trimmedOut, at: Date.now(),
            });
          }
          const trimmedErr = errBuf.trim();
          const status = code === 0 ? "completed" : "failed";
          // Only keep stderr when the run failed — then it is the error to show.
          // On success it is just the CLI's own transcript, which would render
          // as a second copy of the reply when the run is reloaded.
          if (trimmedErr && status === "failed") {
            await appendMessage({ runId, role: "system", body: trimmedErr });
          }
          const stat = sha
            ? await withRepoLock(sessionId, () => diffStat(sessionId, baseSha, sha!)).catch(() => null)
            : { added: 0, removed: 0 };
          await finishRun(runId, {
            status,
            resultSha: sha,
            exitCode: code,
            error: trimmedErr || null,
            addedLines: stat?.added ?? null,
            removedLines: stat?.removed ?? null,
          });
          broadcast({ type: "run.finished", runId, status, headSha: sha, at: Date.now() });

          // Fold a successful exchange into shared memory. A failed run's output
          // is an error, not knowledge, and a code-changing exchange only stages
          // here — it becomes memory when the user approves it by publishing
          // (see shared-memory.ts). Fire-and-forget: it has its own timeout and
          // never throws, and the run must not wait on the memory sidecar.
          if (status === "completed") {
            void ingestExchange({
              sessionId,
              runId,
              prompt: userPrompt,
              reply: trimmedOut,
              changed: sha !== null,
            });
          }
        } catch {
          // The run record is best-effort; the live stream already succeeded.
        }

        send({ t: "exit", code, ms: Date.now() - startedAt, headSha: sha, committed: sha !== null });
        closed = true;
        resolve();
      });

      child.on("error", (cause) => send({ t: "err", d: `${cause.message}\n` }));
    })();
  });
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
