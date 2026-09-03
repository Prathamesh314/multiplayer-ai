import { spawn } from "node:child_process";
import { agentById, resolveChoice } from "../../../lib/ai/catalog";
import {
  appendMessage,
  createRun,
  finishRun,
  getRun,
  joinRun,
  reopenRun,
  runHasOtherAuthors,
} from "../../../lib/ai/runs";
import { checkRunAllowed } from "../../../lib/ai/usage";
import { forkRunMemory, listForkableRuns } from "../../../lib/ai/memory";
import type { ForkableRun } from "../../../lib/ai/memory";
import { buildReferencedContext, extractRunIds } from "../../../lib/ai/context";
import { events } from "../../../lib/events";
import { access, canWrite, denied, forbidden } from "../../../lib/session/auth";
import { workPath } from "../../../lib/session/paths";
import { commitWork, diffStat, ensureWork, withRepoLock } from "../../../lib/session/repo";
import { setHeadSha } from "../../../lib/session/store";
import { terminalAccess } from "../../../lib/terminal/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_RUN_MS = 10 * 60 * 1000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_PROMPT = 20_000;

export type AiRunRequest = {
  sessionId: string;
  agentId: string;
  prompt: string;
  /** Optional title for a new run. */
  title?: string;
  /** Continue an existing run (join-as-editor follow-up) instead of opening one. */
  runId?: string;
  /** Composer choices; validated against the agent's own allow-lists below. */
  model?: string;
  effort?: string;
  /** Import another chat's transcript as this (new) run's opening memory. Ignored when continuing a run. */
  forkFromRunId?: string;
  /**
   * Run ids of chats referenced with `@room/<run-id>` in the prompt. Their most
   * relevant conversations (ranked against this prompt, capped) are injected as
   * <referenced-context>. Also parsed from the prompt text, so a pasted path
   * works even without this field. Applies to new and continuing runs alike.
   */
  contextRefs?: string[];
};

export type AiRunEvent =
  | { t: "start"; agent: string; cwd: string; runId: string }
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

  // A run is now durable. A follow-up prompt (join-as-editor, or the owner's
  // next turn) continues an existing run; otherwise a fresh one is opened. The
  // prompt is stored as the first turn either way, attributed to whoever sent it.
  let run = body.runId ? await getRun(body.runId) : null;
  if (run && run.sessionId !== sessionId) run = null;

  // "Import context from…" only makes sense for a brand new chat. Resolved
  // (and validated against project room visibility, via listForkableRuns)
  // before the cost gate, so a bad request never spends a concurrency slot.
  let forkSource: ForkableRun | null = null;
  if (!run && body.forkFromRunId) {
    if (!result.session.projectId) {
      return Response.json(
        { error: "This room has no project to import context from." },
        { status: 400 },
      );
    }
    const candidates = await listForkableRuns(result.session.projectId, result.user.id);
    forkSource = candidates.find((candidate) => candidate.id === body.forkFromRunId) ?? null;
    if (!forkSource) {
      return Response.json({ error: "That chat isn't available to import from." }, { status: 404 });
    }
  }

  // Cost governor: pooled org limits and the per-project throttle decide whether
  // this agent may spawn at all. Checked before anything is created or run.
  const runGate = await checkRunAllowed({
    orgId: result.session.orgId,
    projectId: result.session.projectId,
    sessionId,
    userId: result.user.id,
    isNewRun: !run,
  });
  if (!runGate.ok) {
    return Response.json({ error: runGate.error, limit: runGate.limit }, { status: 429 });
  }

  // Set when a fork actually happens, so it can be woven into the prompt sent
  // to the agent below — the stored user turn stays exactly what was typed.
  let importedContext: string | null = null;

  if (!run) {
    run = await createRun({
      sessionId,
      startedBy: result.user.id,
      agentId: agent.id,
      baseSha: headSha,
      title: body.title?.trim() || prompt.slice(0, 80),
    });
    await (await events()).publish(sessionId, {
      type: "run.started",
      runId: run.id,
      startedBy: result.user.id,
      startedByName: result.user.displayName,
      agentId: agent.id,
      at: Date.now(),
    });

    if (forkSource) {
      importedContext = await forkRunMemory({
        sourceRunId: forkSource.id,
        destRunId: run.id,
        createdBy: result.user.id,
      });
      const notice = await appendMessage({
        runId: run.id,
        role: "system",
        body: `Imported context from #${forkSource.sessionName}`,
      });
      await (await events()).publish(sessionId, {
        type: "run.turn",
        runId: run.id,
        seq: notice.seq,
        role: "system",
        authorName: null,
        body: notice.body,
        at: Date.now(),
      });
    }
  } else {
    // A second driver on someone else's run is recorded as an editor, and the
    // run is marked running again so it holds a concurrency slot while it works.
    await joinRun(run.id, result.user.id, "editor");
    await reopenRun(run.id);
  }

  // Chats referenced with `@room/<run-id>` (picked in the composer, or a pasted
  // path). Run ids are read straight out of the prompt — and out of the explicit
  // list the client sends — so a token that got edited still resolves by its id.
  // Unlike a fork, this is resolved every turn, so it works on continuations too;
  // access is bounded to rooms the caller can already see.
  let referencedContext: string | null = null;
  const refIds = result.session.projectId
    ? extractRunIds(`${prompt} ${(Array.isArray(body.contextRefs) ? body.contextRefs : []).join(" ")}`)
    : [];
  if (refIds.length > 0 && result.session.projectId) {
    const referenced = await buildReferencedContext({
      projectId: result.session.projectId,
      userId: result.user.id,
      runIds: refIds,
      prompt,
    });
    referencedContext = referenced.text;
    if (referenced.sources.length > 0) {
      const label = referenced.sources.map((source) => `@${source.sessionName}`).join(", ");
      const notice = await appendMessage({
        runId: run.id,
        role: "system",
        body: `Referenced context from ${label}`,
      });
      await (await events()).publish(sessionId, {
        type: "run.turn",
        runId: run.id,
        seq: notice.seq,
        role: "system",
        authorName: null,
        body: notice.body,
        at: Date.now(),
      });
    }
  }

  // On a co-driven run (someone else has also sent prompts into it), tell the
  // agent who is speaking so two people's intents in one run don't blur into
  // one contradictory instruction. Solo runs — the common case — stay untagged,
  // and separate members always have separate runs, so their contexts never mix.
  const coDriven = await runHasOtherAuthors(run.id, result.user.id);
  let agentPrompt = coDriven ? `[@${result.user.handle}] ${prompt}` : prompt;

  // Everything sent to the CLI travels as one argv string capped at MAX_PROMPT,
  // so the woven-in context is bounded here (the stored transcript keeps the
  // full import regardless). Referenced context goes first — it is already the
  // curated, query-ranked slice the asker explicitly pointed at — then the fork
  // import fills whatever budget is left.
  const OVERHEAD = 120;
  if (referencedContext) {
    const budget = Math.max(0, MAX_PROMPT - agentPrompt.length - OVERHEAD);
    const injected =
      referencedContext.length > budget
        ? `${referencedContext.slice(0, budget)}\n[…referenced context truncated for length…]`
        : referencedContext;
    agentPrompt = `<referenced-context>\n${injected}\n</referenced-context>\n\n${agentPrompt}`;
  }
  // Earlier turns are dropped first — the most recent ones are the most likely
  // to matter to a fresh chat.
  if (importedContext) {
    const budget = Math.max(0, MAX_PROMPT - agentPrompt.length - OVERHEAD);
    const injected =
      importedContext.length > budget
        ? `[…earlier context truncated for length…]\n${importedContext.slice(importedContext.length - budget)}`
        : importedContext;
    agentPrompt = `<imported-context>\n${injected}\n</imported-context>\n\n${agentPrompt}`;
  }

  const promptTurn = await appendMessage({
    runId: run.id,
    role: "user",
    authorUserId: result.user.id,
    body: prompt,
  });
  const bus = await events();
  await bus.publish(sessionId, {
    type: "run.turn",
    runId: run.id,
    seq: promptTurn.seq,
    role: "user",
    authorName: result.user.displayName,
    body: prompt,
    at: Date.now(),
  });

  // Only values the agent actually offers reach the argv; anything else is dropped.
  const runOptions = {
    model: resolveChoice(agent.models, body.model),
    effort: resolveChoice(agent.efforts, body.effort),
  };

  const author = { name: result.user.displayName, email: result.user.email };
  return new Response(
    runStream(sessionId, run.id, headSha, agent.bin, agent.promptArgs(agentPrompt, runOptions), author),
    {
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-store, no-transform",
        "x-accel-buffering": "no",
      },
    },
  );
}

function runStream(
  sessionId: string,
  runId: string,
  baseSha: string,
  bin: string,
  args: string[],
  author: { name: string; email: string },
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const cwd = workPath(sessionId);
  const startedAt = Date.now();

  let closed = false;
  let bytes = 0;
  // Buffered to persist as one consolidated turn at close; the live tail goes
  // out over the event bus chunk by chunk for watchers.
  let outBuf = "";
  let errBuf = "";

  const broadcast = (event: Parameters<Awaited<ReturnType<typeof events>>["publish"]>[1]) => {
    void events().then((bus) => bus.publish(sessionId, event)).catch(() => {});
  };

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
        void finishRun(runId, {
          status: "failed",
          error: cause instanceof Error ? cause.message : String(cause),
        });
        broadcast({ type: "run.finished", runId, status: "failed", headSha: null, at: Date.now() });
        closed = true;
        controller.close();
        return;
      }

      send({ t: "start", agent: bin, cwd, runId });

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
          if (kind === "out") outBuf += chunk;
          else errBuf += chunk;
          broadcast({ type: "run.output", runId, stream: kind, chunk, at: Date.now() });
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

        // Persist the run's output as one consolidated turn, then close it out.
        // Errors here must not break the client stream, so they are swallowed.
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
          // On success it is just the CLI's own transcript (Codex echoes its
          // whole session to stderr), which would render as a second copy of
          // the reply when the run is reloaded.
          if (trimmedErr && status === "failed") {
            await appendMessage({ runId, role: "system", body: trimmedErr });
          }
          // Line counts of what the agent changed, for the sidebar's +N -N badge.
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
        } catch {
          // The run record is best-effort; the live stream already succeeded.
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
