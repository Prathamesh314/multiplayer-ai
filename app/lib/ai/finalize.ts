import { notifyUsage } from "../events/notifications";
import { closeTurnInputs } from "./close-inputs";
import { projectRepositoryForRoom } from "../project/repositories";
import { queryOne, transaction } from "../db/client";
import { events } from "../events";
import { ensureRepoContext } from "../knowledge/repo-context";
import { chatBranchOf, diffFilesBare, mergeBase, promoteTurn, withRepoLock, type FileChange } from "../session/repo";
import { ingestExchange } from "./shared-memory";
import { ControlError } from "./turns";

export type FinalizeInput = {
  turnId: string;
  sessionId: string;
  runId: string;
  repoId: string | null;
  baseSha: string;
  userPrompt: string;
  binName: string;
  author: { name: string };
  sha: string | null;
  code: number | null;
  output: string;
  errOutput: string;
  onError?: (message: string) => void;
};

export type FinalizeResult = {
  status: "completed" | "failed";
  changes: FileChange[];
  headSha: string | null;
};

export async function finalizeAgentRun(input: FinalizeInput): Promise<FinalizeResult> {
  const snapshot = await transaction(async tx => {
    const { rows: [run] } = await tx.query(`SELECT * FROM agent_runs WHERE id = $1 FOR UPDATE`, [input.runId]);
    const { rows: [turn] } = await tx.query(`SELECT * FROM agent_turns WHERE id = $1 AND run_id = $2 FOR UPDATE`, [input.turnId, input.runId]);
    if (!turn || !run) throw new ControlError("Unknown execution turn.");
    if (turn.result && ["completed", "failed"].includes(turn.status)) return { done: turn.result as FinalizeResult };
    if (turn.status !== "running" || turn.driver_user_id !== run.driver_user_id || turn.control_version !== run.control_version) throw new ControlError("This execution no longer controls the chat.");
    const { rows: [role] } = await tx.query(`SELECT room_access_role($1, $2) AS role`, [input.sessionId, turn.driver_user_id]);
    if (!["owner", "editor"].includes(role?.role)) throw new ControlError("Execution access was revoked.", 403);
    const { rows: [job] } = await tx.query(`SELECT *, lease_expires_at > now() AS live FROM runner_jobs WHERE turn_id = $1`, [input.turnId]);
    if (turn.execution_target === 'local' && job && !turn.completion && (job.status !== "claimed" || !job.live)) throw new ControlError("The runner lease expired. Recover control before retrying.");
    if (turn.execution_target === 'server' && turn.execution_token && !turn.completion && new Date(turn.execution_lease_until).getTime() <= Date.now()) throw new ControlError("The executor lease expired. The candidate is preserved for review.");
    await closeTurnInputs(tx, input.turnId);
    const saved = turn.completion ?? { ...input, onError: undefined };
    await tx.query(`UPDATE agent_turns SET completion = $2 WHERE id = $1`, [input.turnId, JSON.stringify(saved)]);
    return { input: saved as FinalizeInput };
  });
  if (snapshot.done) return snapshot.done;
  const saved = snapshot.input!;
  const repoRef = saved.repoId ?? saved.sessionId;
  let isolated = false;
  const committed = await withRepoLock(repoRef, () => transaction(async tx => {
    const { rows: [run] } = await tx.query(`SELECT *,room_access_role(session_id,driver_user_id) AS role FROM agent_runs WHERE id = $1 FOR UPDATE`, [saved.runId]);
    const { rows: [turn] } = await tx.query(`SELECT * FROM agent_turns WHERE id = $1 FOR UPDATE`, [saved.turnId]);
    // An isolated chat's turns promote onto its own branch and leave the room
    // head alone; the room branch only moves when the chat is merged.
    isolated = run.isolation === "isolated";
    if (turn.result) return { result: turn.result as FinalizeResult, fresh: false };
    if (turn.status !== 'running' || run.driver_user_id !== turn.driver_user_id || run.control_version !== turn.control_version || !['owner','editor'].includes(run.role)) {
      throw new ControlError("Execution lost access or control before publishing. Its candidate was preserved.");
    }
    let sha = saved.sha;
    let failure = saved.errOutput.trim();
    // Stopped by its driver: whatever the agent wrote and changed so far is kept,
    // like a finished turn, and the chat says it was stopped.
    const stopped = !!turn.stop_requested_at;
    let status: "completed" | "failed" = saved.code === 0 || stopped ? "completed" : "failed";
    if (sha) {
      try {
        await promoteTurn(repoRef, saved.turnId, saved.baseSha, sha, isolated ? chatBranchOf(run.id) : undefined);
      } catch (cause) {
        status = "failed";
        failure += `\n${cause instanceof Error ? cause.message : String(cause)}\nCandidate: refs/turns/${saved.turnId}`;
        sha = null;
      }
    }
    if (sha && isolated) {
      // New work after a merge is a new proposal; a discarded chat stays discarded.
      await tx.query(`UPDATE agent_runs SET head_sha = $2,
        merge_state = CASE WHEN merge_state = 'merged' THEN 'open' ELSE merge_state END WHERE id = $1`, [saved.runId, sha]);
    } else if (sha) {
      await tx.query(saved.repoId
        ? `UPDATE room_repos SET head_sha = $2 WHERE id = $1`
        : `UPDATE session_repos SET head_sha = $2 WHERE session_id = $1`, [repoRef, sha]);
    }
    const changes = sha ? await diffFilesBare(repoRef, saved.baseSha, sha) : [];
    // The chat list shows an isolated chat's whole proposal against the room,
    // not just its latest turn: measured from where it last met the room branch.
    // A turn that changed nothing still leaves the earlier turns' proposal.
    let totals = changes;
    const tip: string | null = isolated ? sha ?? run.head_sha : null;
    if (tip) {
      const { rows: [room] } = await tx.query(saved.repoId
        ? `SELECT head_sha FROM room_repos WHERE id = $1`
        : `SELECT head_sha FROM session_repos WHERE session_id = $1`, [repoRef]);
      const base = room?.head_sha ? await mergeBase(repoRef, room.head_sha, tip) : null;
      totals = base ? await diffFilesBare(repoRef, base, tip) : changes;
    }
    const messages = [
      ...(saved.output.trim() ? [{ role: "agent", body: saved.output.trim() }] : []),
      ...(status === "failed" ? [{ role: "system", body: failure || "Execution failed before producing a confirmed result." }] : []),
      ...(stopped && status === "completed" ? [{ role: "system", body: "Stopped." }] : []),
      // Which files changed is in the Changes tab and the turn's diff stats; the
      // chat keeps to the conversation.
    ];
    let agentMessageId: string | null = null;
    for (const message of messages) {
      const { rows: [storedMessage] } = await tx.query(`WITH allocated AS (
        UPDATE agent_runs SET message_seq = message_seq + 1 WHERE id = $1 RETURNING message_seq
      ) INSERT INTO agent_run_messages(run_id, seq, role, body)
        SELECT $1, message_seq, $2, $3 FROM allocated RETURNING id`, [saved.runId, message.role, message.body]);
      if (message.role === "agent") agentMessageId = storedMessage.id;
    }
    await closeTurnInputs(tx, saved.turnId);
    const result: FinalizeResult = { status, changes, headSha: sha };
    await tx.query(`UPDATE agent_turns SET status = $2, result = $3, ended_at = now() WHERE id = $1`, [saved.turnId, status, JSON.stringify(result)]);
    await tx.query(`UPDATE agent_runs SET status = $2, result_sha = $3, exit_code = $4, error = $5,
      added_lines = $6, removed_lines = $7, ended_at = now() WHERE id = $1`,
    [saved.runId, status, sha, status === "failed" ? (saved.code || 1) : 0, status === "failed" ? failure : null,
      totals.reduce((sum, file) => sum + file.added, 0), totals.reduce((sum, file) => sum + file.removed, 0)]);
    await tx.query(`UPDATE runner_jobs SET status = 'done' WHERE turn_id = $1`, [saved.turnId]);
    // A stopped exchange is unfinished: it is not learned from.
    if (status === "completed" && !stopped) {
      await ingestExchange(tx, { sessionId: saved.sessionId, runId: saved.runId, turnId: saved.turnId,
        prompt: saved.userPrompt, reply: saved.output, agentMessageId, commitSha: sha, repoRef });
    }
    return { result, fresh: true };
  }));
  void notifyUsage(saved.sessionId);
  const result = committed.result;
  const bus = await events();
  // file.saved moves every open editor to a new room head, which an isolated
  // turn never produces.
  if (result.headSha && !isolated) await bus.publish(saved.sessionId, {
    type: "file.saved", repoId: saved.repoId, path: "", headSha: result.headSha,
    authorId: "agent", authorName: saved.author.name, originId: null, at: Date.now(),
  }).catch(() => {});
  await bus.publish(saved.sessionId, { type: "run.finished", runId: saved.runId, status: result.status, headSha: result.headSha, at: Date.now() }).catch(() => {});
  if (committed.fresh && result.status === "completed") {
    const session = await queryOne<{ project_id: string | null }>(`SELECT project_id FROM sessions WHERE id = $1`, [saved.sessionId]);
    const publishGated = !!session?.project_id && (saved.repoId === null || !!await projectRepositoryForRoom(saved.sessionId, saved.repoId));
    if (result.headSha && !publishGated && !isolated) await ensureRepoContext(repoRef, result.headSha);
  }
  return result;
}

export async function reconcileCompletions(runId: string): Promise<void> {
  const pending = await queryOne<{ completion: FinalizeInput }>(
    `SELECT completion FROM agent_turns WHERE run_id = $1 AND status = 'running' AND completion IS NOT NULL`, [runId],
  );
  if (pending) await finalizeAgentRun(pending.completion);
}
