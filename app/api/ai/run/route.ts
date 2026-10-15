import { withApiLimit } from "../../../lib/http/api-limit";
import { getCheckpoint } from "../../../lib/runner/checkpoints";
import { projectRepositoryForRoom } from "../../../lib/project/repositories";
import { randomUUID } from "node:crypto";
import { continuationContext } from "../../../lib/ai/handoff";
import { ControlError, isUuid, reserveTurn, prepareTurn, failTurn } from "../../../lib/ai/turns";
import { queryOne } from "../../../lib/db/client";
import { modelInventory, validModelId } from "../../../lib/ai/model-discovery";
import { agentById } from "../../../lib/ai/catalog";
import { executeAgentRun } from "../../../lib/ai/execute";
import {
  appendMessage,
  autoRenameRun,
  createRun,
  getRun,
  joinRun,
  runHasOtherAuthors,
} from "../../../lib/ai/runs";
import { draftRunTitle, refineRunTitle, MAX_TITLE } from "../../../lib/ai/titles";
import { checkRunAllowed } from "../../../lib/ai/usage";
import { forkRunMemory, listForkableRuns } from "../../../lib/ai/memory";
import type { ForkableRun } from "../../../lib/ai/memory";
import { buildReferencedContext, extractRunIds } from "../../../lib/ai/context";
import { buildKnowledgeContext } from "../../../lib/knowledge";
import { assembleAgentPrompt, MAX_PROMPT } from "../../../lib/ai/prompt";
import type { AgentRunJob, AiRunEvent } from "../../../lib/ai/run-events";
import { subscribeRunEvents } from "../../../lib/ai/run-stream";
import { enqueueRun, queueEnabled } from "../../../lib/queue";
import { hasOnlineDevice } from "../../../lib/runner/devices";
import {
  CLAIM_FALLBACK_MS,
  enqueueLocalJob,
  localRunnersEnabled,
  reclaimForServer,
} from "../../../lib/runner/jobs";
import { events } from "../../../lib/events";
import { resolveRepository } from "../../../lib/session/repository-context";
import { chatBranchOf } from "../../../lib/session/repo";
import { parallelChatsEnabled } from "../../../lib/ai/isolation";
import { access, canWrite, denied, forbidden } from "../../../lib/session/auth";
import { terminalAccess } from "../../../lib/terminal/guard";

export type { AiRunEvent } from "../../../lib/ai/run-events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * How long the response will wait on a worker before giving up. A worker that
 * is SIGKILLed mid-run never emits `exit`; BullMQ fails the stalled job, but
 * this stream would otherwise hang, so it is closed a little past the run cap.
 */
const RUN_STREAM_TIMEOUT_MS = 11 * 60 * 1000;

export type AiRunRequest = {
  sessionId: string;
  agentId: string;
  prompt: string;
  /** Optional title for a new run. */
  title?: string;
  /** Continue an existing run (join-as-editor follow-up) instead of opening one. */
  runId?: string;
  turnId?: string;
  controlVersion?: number;
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
  /**
   * Which of the room's repos this (new) chat works on: a room_repos id, or
   * omitted for the room's own project fork. A continued run keeps the repo it
   * started on — a thread never switches codebases midway.
   */
  repoId?: string;
  /**
   * "isolated" opens a new chat on its own branch so it can run alongside the
   * person's other chats (see lib/ai/isolation.ts). A continued run keeps the
   * mode it was opened with.
   */
  isolation?: "isolated" | "shared";
};

/**
 * Improve a brand-new chat's drafted name, once, in the background.
 *
 * Deliberately not awaited: the run is already starting, and a naming gateway
 * that is slow or down must never delay or fail a turn. `autoRenameRun` is the
 * safety catch — if the driver renamed the chat while this was in flight, the
 * update matches no row and nothing is broadcast.
 */
async function nameChat(sessionId: string, runId: string, prompt: string): Promise<void> {
  try {
    const refined = await refineRunTitle(prompt);
    if (!refined) return;
    const title = await autoRenameRun(runId, refined.slice(0, MAX_TITLE));
    if (!title) return;
    await (await events()).publish(sessionId, { type: "run.renamed", runId, title, at: Date.now() });
  } catch (cause) {
    console.warn("Chat naming failed", cause);
  }
}

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
async function handlePOST(request: Request) {
  let body: AiRunRequest;
  try {
    body = (await request.json()) as AiRunRequest;
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  if (!body || typeof body !== "object" || (body.runId && !isUuid(body.runId)) || (body.turnId && !isUuid(body.turnId))) {
    return Response.json({ error: "Invalid chat or turn ID." }, { status: 400 });
  }
  const turnId = body.turnId ?? randomUUID();
  if (await queryOne(`SELECT id FROM agent_turns WHERE id = $1`, [turnId])) {
    return Response.json({ error: "This prompt has already been submitted. Reload the chat." }, { status: 409 });
  }
  const result = await access(String(body.sessionId ?? ""));
  const refusal = denied(result);
  if (refusal || !result) return refusal!;

  if (!canWrite(result.role)) {
    return forbidden("Running an agent changes files, which needs edit access.");
  }

  const gate = terminalAccess(request);


  const agent = agentById(String(body.agentId ?? ""));
  if (!agent) return Response.json({ error: "Unknown agent." }, { status: 400 });

  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) return Response.json({ error: "Write a prompt first." }, { status: 400 });
  if (prompt.length > MAX_PROMPT - 8000) {
    return Response.json({ error: "Use at most 12,000 characters, leaving room for conversation context." }, { status: 413 });
  }

  if (body.model != null && body.model !== "" && !validModelId(body.model)) return Response.json({ error: "Invalid model ID." }, { status: 400 });
  if (body.effort != null && body.effort !== "" && (typeof body.effort !== "string" || !/^[a-z]{1,20}$/.test(body.effort))) return Response.json({ error: "Invalid reasoning effort." }, { status: 400 });
  if (agent.requiresModel && !body.model) return Response.json({ error: "Choose a model available on your execution machine." }, { status: 400 });
  const runOptions = { model: body.model || undefined, effort: body.effort || undefined };
  const hasRunner = localRunnersEnabled() && await hasOnlineDevice(result.user.id, agent.id, undefined, undefined, true);
  const useLocal = localRunnersEnabled() && await hasOnlineDevice(result.user.id, agent.id, runOptions.model, runOptions.effort);
  if (!useLocal && hasRunner) return Response.json({ error: "Your computer doesn’t have the selected model or effort available. Refresh the model list and choose an available option, then send your message again." }, { status: 409 });
  if (!useLocal && gate.allowed) {
    const inventory = await modelInventory(agent);
    const selected = inventory.choices.find(choice => choice.id === (runOptions.model ?? ""));
    if (!selected || (runOptions.effort && !selected.efforts?.some(effort => effort.id === runOptions.effort))) return Response.json({ error: "This model or effort is no longer available. Refresh the provider inventory." }, { status: 409 });
  }
  if (!useLocal && !gate.allowed) return Response.json({ error: `We couldn’t start ${agent.name} on your computer. Open the desktop app, sign in with this account, and make sure ${agent.name} is installed and signed in. Then send your message again. Your saved chat is still available.`, code: "computer_connection_required" }, { status: 409 });

  const sessionId = result.session.id;

  // A run is now durable. A follow-up prompt (join-as-editor, or the owner's
  // next turn) continues an existing run; otherwise a fresh one is opened. The
  // prompt is stored as the first turn either way, attributed to whoever sent it.
  let run = body.runId ? await getRun(body.runId) : null;
  if (body.runId && (!run || run.sessionId !== sessionId)) return Response.json({ error: "Chat not found." }, { status: 404 });
  if (run && (run.driverUserId !== result.user.id || body.controlVersion !== run.controlVersion)) {
    return Response.json({ error: "Only the current driver can continue. Refresh or accept a handoff." }, { status: 409 });
  }
  if (run && run.controlVersion > 0 && !useLocal) return Response.json({ error: "Connect your computer and set up this AI tool before continuing the chat that was handed to you.", code: "computer_connection_required" }, { status: 409 });

  if (body.isolation != null && body.isolation !== "isolated" && body.isolation !== "shared") {
    return Response.json({ error: "Invalid chat isolation." }, { status: 400 });
  }
  const isolated = run ? run.isolation === "isolated" : body.isolation === "isolated";
  if (run?.mergeState === "discarded") {
    return Response.json({ error: "This parallel chat was discarded. Reopen it to continue." }, { status: 409 });
  }
  if (isolated && !run && !parallelChatsEnabled()) {
    return Response.json({ error: "Parallel chats are not enabled on this server." }, { status: 400 });
  }
  // An older runner keeps one worktree per room repository and cannot hold a
  // chat's own branch; it would never claim this turn.
  if (isolated && useLocal && !await hasOnlineDevice(result.user.id, agent.id, runOptions.model, runOptions.effort, false, true)) {
    return Response.json({ error: "Update the desktop app to run parallel chats, then send your message again.", code: "runner_update_required" }, { status: 409 });
  }

  // Which repo the chat works on. A continued run keeps the repo it started
  // on; a new one takes the picker's choice — an imported room repo, or the
  // room's own project fork by default. Validated against this room before
  // anything is created, and an import still mid-upload takes no runs.
  let repoId: string | null = run ? run.repoId : null;
  if (!run && typeof body.repoId === "string" && body.repoId) repoId = body.repoId;
  const repository = await resolveRepository(result.session, repoId);
  if (repository instanceof Response) return repository;
  // An isolated chat continues from its own branch; a new one forks the room head.
  const headSha = run?.isolation === "isolated" && run.headSha ? run.headSha : repository.headSha;

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
    isolation: isolated ? "isolated" : "shared",
  });
  if (!runGate.ok) {
    return Response.json({ error: runGate.error, limit: runGate.limit }, { status: 429 });
  }

  // Set when a fork actually happens, so it can be woven into the prompt sent
  // to the agent below — the stored user turn stays exactly what was typed.
  let importedContext: string | null = null;

  if (!run) {
    // A chat is named from the request that opens it, and only then. The draft
    // is pure and instant so the first turn pays nothing for it; when a naming
    // gateway is configured, a better name replaces it a moment later (below).
    // A client-supplied title is a person's choice and is never refined.
    const supplied = typeof body.title === "string" ? body.title.trim().slice(0, MAX_TITLE) : "";
    run = await createRun({
      sessionId,
      repoId,
      startedBy: result.user.id,
      agentId: agent.id,
      baseSha: headSha,
      title: supplied || draftRunTitle(prompt),
      titleSource: supplied ? "manual" : "auto",
      isolation: isolated ? "isolated" : "shared",
    });
    if (!supplied) void nameChat(sessionId, run.id, prompt);
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

  }

  try {
    await reserveTurn(run.id, result.user.id, turnId, run.controlVersion);
    await (await events()).publish(sessionId, { type: "run.control", runId: run.id, at: Date.now() }).catch(() => {});
  } catch (cause) {
    if (cause instanceof ControlError) return Response.json({ error: cause.message }, { status: cause.status });
    throw cause;
  }
  try {

  // Materializing the working copy used to happen here; it now happens inside
  // executeAgentRun (see below), so it is identical whether the turn runs inline
  // or in a worker — and, in the worker case, on the machine that will actually
  // spawn the agent. A prepare failure surfaces as the run's own failure event
  // rather than a 500, keeping the run row and the live stream consistent.

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

  // The knowledge layer: the prompt is routed over the project's knowledge
  // graph (project → rooms → runs, plus the indexed repo node), and the right
  // banks are recalled — distilled cross-chat memory, the room's canonical
  // facts, and repo context when the prompt is code-shaped. Unlike the FTS
  // reference above (a specific chat, keyword-matched), this is ambient and
  // meaning-ranked, and it fans out only over visible rooms so it can't widen
  // access. Human project-room chat uses Postgres even without the sidecar.
  let sharedMemory: string | null = null;
  let repoContext: string | null = null;
  let roomChatContext: string | null = null;
  {
    // Personal rooms included: the graph shrinks to the room itself, but the
    // AI still reads its own memory and the context of the repo it will edit.
    const knowledge = await buildKnowledgeContext({
      projectId: result.session.projectId,
      userId: result.user.id,
      currentSessionId: sessionId,
      repoId,
      prompt,
    });
    sharedMemory = knowledge.memoryText;
    repoContext = knowledge.repoText;
    roomChatContext = knowledge.chatText;
    if (knowledge.recalled > 0 || knowledge.repoRecalled > 0 || knowledge.chatRecalled > 0) {
      const parts: string[] = [];
      if (knowledge.recalled > 0) parts.push(`${knowledge.recalled} memories from shared context`);
      if (knowledge.repoRecalled > 0) parts.push(`${knowledge.repoRecalled} repo facts`);
      if (knowledge.chatRecalled > 0) {
        const rooms = [...new Set(knowledge.chatSources.map((source) => source.roomName))];
        const people = [...new Set(knowledge.chatSources.map((source) => `@${source.handle}`))];
        parts.push(`${knowledge.chatRecalled} team discussion messages from ${rooms.join(", ")} (${people.join(", ")})`);
      }
      const suffix =
        knowledge.truncatedRooms > 0
          ? ` (${knowledge.truncatedRooms} more rooms not searched)`
          : "";
      const notice = await appendMessage({
        runId: run.id,
        role: "system",
        body: `Recalled ${parts.join(" and ")}${suffix}`,
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

  const coDriven = await runHasOtherAuthors(run.id, result.user.id);

  // Everything sent to the CLI travels as one argv string capped at MAX_PROMPT.
  // The context layers are woven and budgeted in assembleAgentPrompt (see
  // app/lib/ai/prompt.ts), which the stored transcript is unaffected by — it
  // keeps the full import regardless.
  const agentPrompt = assembleAgentPrompt({
    prompt,
    handle: coDriven ? result.user.handle : null,
    referencedContext,
    conversationContext: await continuationContext(run.id),
    importedContext,
    repoContext,
    sharedMemory,
    structuredMemory: true,
    roomChatContext,
  });

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

  const author = { name: result.user.displayName, email: result.user.email };

  // Everything the run needs is now plain data. The agent's bin/args/parser are
  // rebuilt from agentId inside executeAgentRun, because they are functions and
  // cannot cross a queue (see AgentRunJob).
  const restoreCheckpoint = run.restoreSnapshotId ? await getCheckpoint(run.restoreSnapshotId, run.id) : null;
  const job: AgentRunJob = {
    ...(restoreCheckpoint ? { restoreCheckpoint } : {}),
    turnId,
    userId: result.user.id,
    controlVersion: run.controlVersion,
    sessionId,
    runId: run.id,
    repoId,
    projectRepositoryId: await projectRepositoryForRoom(sessionId, repoId),
    workspaceNames: { repository: repository.rootName, room: result.session.name, ...(isolated ? { chat: run.title ?? "" } : {}) },
    baseSha: headSha,
    ...(isolated ? { isolation: "isolated" as const, chatBranch: chatBranchOf(run.id) } : {}),
    agentId: agent.id,
    agentPrompt,
    projectId: result.session.projectId,
    model: runOptions.model,
    effort: runOptions.effort,
    author,
    userPrompt: prompt,
  };

  await prepareTurn(job, useLocal ? "local" : "server");

  const headers = {
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-store, no-transform",
    "x-accel-buffering": "no",
  };

  // Three ways to run, one client contract. Local-first: when the initiating
  // user has a runner online, the job goes to *their machine* — their CPU,
  // their AI login (docs/local-execution.md) — and this response forwards the
  // runner's events off the same per-run channel a worker would use. No
  // runner online: with Redis the turn goes to a server worker; without, it
  // runs inline. The browser reads the same NDJSON stream in every case.
  if (useLocal) {
    return new Response(localStream(job, result.user.id), { headers });
  }
  return new Response(queueEnabled() ? queuedStream(job) : inlineStream(job), { headers });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "Could not prepare this turn.";
    await failTurn(turnId, message);
    return Response.json({ error: message }, { status: 500 });
  }
}

const encoder = new TextEncoder();
const frame = (event: AiRunEvent) => encoder.encode(`${JSON.stringify(event)}\n`);

/**
 * No Redis: run the turn inline in the web process and stream its events
 * straight down the response. This is the pre-worker behaviour, preserved so
 * local development needs no extra infrastructure.
 */
function inlineStream(job: AgentRunJob): ReadableStream<Uint8Array> {
  let closed = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      void executeAgentRun(job, (event) => {
        if (closed) return;
        try {
          controller.enqueue(frame(event));
        } catch {
          // The reader went away; the run finishes and commits regardless.
        }
      }).finally(() => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      });
    },
    cancel() {
      // The run keeps going in this process and still commits; a driver leaving
      // must not abort work others are watching.
      closed = true;
    },
  });
}

export const POST = withApiLimit("/api/ai/run", handlePOST);

/**
 * Redis: the worker runs the turn; this forwards its events off the per-run
 * channel. Subscribe *before* enqueuing so no early event slips through the gap
 * between the worker picking the job up and us listening.
 */
function queuedStream(job: AgentRunJob): ReadableStream<Uint8Array> {
  let closed = false;
  let unsubscribe: (() => Promise<void>) | null = null;
  let timeout: ReturnType<typeof setTimeout> | null = null;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const shutdown = () => {
        if (closed) return;
        closed = true;
        if (timeout) clearTimeout(timeout);
        void unsubscribe?.().catch(() => {});
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      };

      unsubscribe = await subscribeRunEvents(job.turnId, (event) => {
        if (closed) return;
        try {
          controller.enqueue(frame(event));
        } catch {
          // Reader gone; the worker still finishes and commits.
        }
        // The worker's terminal event ends the response too.
        if (event.t === "exit") shutdown();
      });

      try {
        await enqueueRun(job);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        controller.enqueue(frame({ t: "err", d: `Could not queue the run: ${message}` }));
        controller.enqueue(frame({ t: "exit", code: null, ms: 0, headSha: null, committed: false }));
        await failTurn(job.turnId, message).catch(() => {});
        const bus = await events();
        await bus
          .publish(job.sessionId, {
            type: "run.finished",
            runId: job.runId,
            status: "failed",
            headSha: null,
            at: Date.now(),
          })
          .catch(() => {});
        shutdown();
        return;
      }

      // Safety net: a worker SIGKILLed mid-run never emits `exit`. BullMQ fails
      // the stalled job, but this response would otherwise hang, so close it a
      // little past the run cap.
      timeout = setTimeout(() => {
        if (closed) return;
        controller.enqueue(frame({ t: "notice", message: "The run stream timed out." }));
        shutdown();
      }, RUN_STREAM_TIMEOUT_MS);
      timeout.unref?.();
    },
    cancel() {
      closed = true;
      if (timeout) clearTimeout(timeout);
      void unsubscribe?.().catch(() => {});
    },
  });
}

function localStream(job: AgentRunJob, userId: string): ReadableStream<Uint8Array> {
  let closed = false;
  let unsubscribe: (() => Promise<void>) | null = null;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let fallback: ReturnType<typeof setTimeout> | null = null;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const shutdown = () => {
        if (closed) return;
        closed = true;
        if (timeout) clearTimeout(timeout);
        if (fallback) clearTimeout(fallback);
        void unsubscribe?.().catch(() => {});
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      };

      const fail = async (message: string) => {
        controller.enqueue(frame({ t: "err", d: message }));
        controller.enqueue(frame({ t: "exit", code: null, ms: 0, headSha: null, committed: false }));
        await failTurn(job.turnId, message).catch(() => {});
        const bus = await events();
        await bus
          .publish(job.sessionId, {
            type: "run.finished",
            runId: job.runId,
            status: "failed",
            headSha: null,
            at: Date.now(),
          })
          .catch(() => {});
        shutdown();
      };

      // Subscribe before enqueueing so no early event slips through the gap.
      unsubscribe = await subscribeRunEvents(job.turnId, (event) => {
        if (closed) return;
        try {
          controller.enqueue(frame(event));
        } catch {
          // Reader gone; the runner still finishes and reports.
        }
        if (event.t === "exit") shutdown();
      });

      try {
        await enqueueLocalJob(job, userId);
        controller.enqueue(frame({ t: "notice", message: "Queued for your runner. No agent has started yet." }));
      } catch (cause) {
        await fail(`Could not queue the run: ${cause instanceof Error ? cause.message : String(cause)}`);
        return;
      }

      fallback = setTimeout(() => {
        void (async () => {
          if (closed) return;
          const reclaimed = await reclaimForServer(job.turnId).catch(() => null);
          if (!reclaimed) return; // a runner has it; its events keep flowing
          await fail("Your runner did not collect this turn. Reconnect it and submit again; nothing ran on the server.");
        })();
      }, CLAIM_FALLBACK_MS);
      fallback.unref?.();

      // Safety net: same stream timeout as the worker path.
      timeout = setTimeout(() => {
        if (closed) return;
        controller.enqueue(frame({ t: "notice", message: "The run stream timed out." }));
        shutdown();
      }, RUN_STREAM_TIMEOUT_MS);
      timeout.unref?.();
    },
    cancel() {
      closed = true;
      if (timeout) clearTimeout(timeout);
      if (fallback) clearTimeout(fallback);
      void unsubscribe?.().catch(() => {});
    },
  });
}
