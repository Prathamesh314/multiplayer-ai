import { startTurn, failTurn, renewServerTurn } from "./turns";
import { randomUUID } from "node:crypto";
import { events } from "../events";
import { commitTurnWork, prepareTurnWork } from "../session/repo";
import { agentById } from "./catalog";
import { finalizeAgentRun } from "./finalize";
import { appendMessage } from "./runs";
import { serverInputSource } from "./input-queue";
import { runAgentLocally } from "../../../runner/execute";
import type { AgentRunJob, AiRunEvent } from "./run-events";

/** Server workers and desktop runners share the provider protocol and limits. */
export async function executeAgentRun(job: AgentRunJob, onEvent: (event: AiRunEvent) => void): Promise<void> {
  const { sessionId, runId, baseSha, author, userPrompt } = job;
  const repoRef = job.repoId ?? sessionId;
  const broadcast = (event: Parameters<Awaited<ReturnType<typeof events>>["publish"]>[1]) => {
    void events().then(bus => bus.publish(sessionId, event)).catch(() => {});
  };
  const send = (event: AiRunEvent) => {
    onEvent(event);
    if (event.t === "out" || event.t === "err") broadcast({ type: "run.output", runId, stream: event.t, chunk: event.d, at: Date.now() });
    if (event.t === "notice") void appendMessage({ runId, role: "system", body: event.message }).then(turn =>
      broadcast({ type: "run.turn", runId, seq: turn.seq, role: "system", authorName: null, body: turn.body, at: Date.now() })).catch(() => {});
  };
  const executionToken = randomUUID();
  if (!await startTurn(job, executionToken)) { send({ t: "notice", message: "This turn was already claimed or is no longer eligible to execute." }); return; }
  const controller = new AbortController();
  let renewing = false;
  const heartbeat = setInterval(() => {
    if (renewing) return;
    renewing = true;
    void renewServerTurn(job.turnId,executionToken).then(live => { if (!live) controller.abort(); }, () => controller.abort()).finally(() => { renewing = false; });
  },10_000);
  heartbeat.unref();
  let inputs: Awaited<ReturnType<typeof serverInputSource>> | undefined;
  try {
    const agent = agentById(job.agentId);
    if (!agent) throw new Error("Unknown agent.");
    const cwd = await prepareTurnWork(repoRef, job.turnId, baseSha);
    inputs = await serverInputSource(job);
    send({ t: "start", agent: agent.bin, cwd, runId });
    const result = await runAgentLocally({ spec: agent, prompt: job.agentPrompt, model: job.model, effort: job.effort, cwd, inputs, onEvent: send, signal: controller.signal });
    let sha: string | null = null;
    try { sha = await commitTurnWork(repoRef, job.turnId, baseSha, author); }
    catch (cause) { result.code = 1; result.errOutput += `Could not commit the changes: ${String(cause)}\n`; send({ t: "err", d: result.errOutput }); }
    const finalized = await finalizeAgentRun({ turnId: job.turnId, sessionId, runId, repoId: job.repoId, baseSha, userPrompt,
      binName: agent.bin, author, sha, code: result.code, output: result.output, errOutput: result.errOutput,
      onError: message => send({ t: "err", d: message }),
    });
    send({ t: "exit", code: finalized.status === "failed" ? 1 : result.code, ms: result.ms,
      headSha: finalized.headSha, committed: finalized.headSha != null, changes: finalized.changes.length ? finalized.changes : undefined });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    send({ t: "err", d: message });
    await failTurn(job.turnId, message).catch(() => {});
    broadcast({ type: "run.finished", runId, status: "failed", headSha: null, at: Date.now() });
    send({ t: "exit", code: null, ms: 0, headSha: null, committed: false });
  } finally { clearInterval(heartbeat); await inputs?.close(); }
}
