/*
 * Closing a run out — the one implementation both execution planes share.
 *
 * A run ends the same way wherever it executed: advance the repo's head to
 * the commit it produced, persist the reply as the agent turn, record the
 * diff, mark the run finished, tell the room, and fold the exchange into
 * shared memory. This used to live inline in executeAgentRun's close
 * handler; it moved here because the runner protocol's /complete route needs
 * the identical sequence for runs that executed on a member's machine —
 * cloud and local runs must be indistinguishable from the transcript out.
 *
 * The caller supplies the commit (the server executor makes it with
 * commitWork; a runner pushes it over smart-HTTP and the complete route
 * verifies it) — this module never touches a working copy.
 */

import { queryOne } from "../db/client";
import { events } from "../events";
import { ensureRepoContext } from "../knowledge/repo-context";
import { diffFilesBare, diffStatBare } from "../session/repo";
import type { FileChange } from "../session/repo";
import { setRoomRepoHeadSha } from "../session/roomRepos";
import { setHeadSha } from "../session/store";
import { appendMessage, finishRun } from "./runs";
import { ingestExchange } from "./shared-memory";

export type FinalizeInput = {
  sessionId: string;
  runId: string;
  /** The room repo the run worked on; null = the room's own project fork. */
  repoId: string | null;
  baseSha: string;
  /** The raw prompt the person typed, for the shared-memory ingest only. */
  userPrompt: string;
  /** The agent executable's name, for commit/broadcast attribution. */
  binName: string;
  author: { name: string };
  /** The commit the run produced — already in the bare repo — or null. */
  sha: string | null;
  code: number | null;
  output: string;
  errOutput: string;
  /** Surfaced into the driver's stream when the head advance fails. */
  onError?: (message: string) => void;
};

/** How many files the durable changes turn names before summarizing the rest. */
const MAX_CHANGED_FILES_LISTED = 20;

export type FinalizeResult = {
  status: "completed" | "failed";
  /** Per-file line deltas of the run's commit; empty when nothing changed. */
  changes: FileChange[];
};

/** The one line-per-file format both the transcript and the live exit use. */
export function formatChanges(changes: FileChange[]): string {
  const added = changes.reduce((sum, file) => sum + file.added, 0);
  const removed = changes.reduce((sum, file) => sum + file.removed, 0);
  const lines = changes
    .slice(0, MAX_CHANGED_FILES_LISTED)
    .map((file) => `· ${file.path}  +${file.added} −${file.removed}`);
  if (changes.length > MAX_CHANGED_FILES_LISTED) {
    lines.push(`…and ${changes.length - MAX_CHANGED_FILES_LISTED} more files`);
  }
  return [
    `Changed ${changes.length} file${changes.length === 1 ? "" : "s"} (+${added} −${removed})`,
    ...lines,
  ].join("\n");
}

/** The run's terminal record, as the transcript and the room will keep it. */
export async function finalizeAgentRun(input: FinalizeInput): Promise<FinalizeResult> {
  const { sessionId, runId, repoId, sha } = input;
  const repoRef = repoId ?? sessionId;
  const status = input.code === 0 ? "completed" : "failed";

  // Whether this room's fork has a publish flow at all. Personal rooms don't,
  // so for them — exactly like imported repos — run completion is the only
  // approval there is, for both memory ingest and repo-context refresh.
  const sessionRow = await queryOne<{ project_id: string | null }>(
    `SELECT project_id FROM sessions WHERE id = $1`,
    [sessionId],
  ).catch(() => null);
  const publishFlowExists = repoId === null && sessionRow?.project_id != null;

  const broadcast = (event: Parameters<Awaited<ReturnType<typeof events>>["publish"]>[1]) => {
    void events().then((bus) => bus.publish(sessionId, event)).catch(() => {});
  };

  // Advance whichever record owns this repo's head: the imported repo's row,
  // or the room's session_repos as always — and let every open editor know.
  if (sha) {
    try {
      if (repoId) await setRoomRepoHeadSha(repoId, sha);
      else await setHeadSha(sessionId, sha);
      broadcast({
        type: "file.saved",
        path: "",
        headSha: sha,
        authorId: "agent",
        authorName: `${input.author.name} · ${input.binName}`,
        originId: null,
        at: Date.now(),
      });
    } catch (cause) {
      input.onError?.(`Could not record the commit: ${String(cause)}\n`);
    }
  }

  // Persist the output as one consolidated turn, then close the run out.
  // Errors here must not break the live stream, so they are swallowed.
  let changes: FileChange[] = [];
  try {
    const trimmedOut = input.output.trim();
    if (trimmedOut) {
      const turn = await appendMessage({ runId, role: "agent", body: trimmedOut });
      broadcast({
        type: "run.turn", runId, seq: turn.seq, role: "agent",
        authorName: null, body: trimmedOut, at: Date.now(),
      });
    }
    const trimmedErr = input.errOutput.trim();
    // Only keep stderr when the run failed — then it is the error to show.
    // On success it is just the CLI's own transcript, which would render
    // as a second copy of the reply when the run is reloaded.
    if (trimmedErr && status === "failed") {
      const errTurn = await appendMessage({ runId, role: "system", body: trimmedErr });
      broadcast({
        type: "run.turn", runId, seq: errTurn.seq, role: "system",
        authorName: null, body: trimmedErr, at: Date.now(),
      });
    }

    // What the run touched, file by file — against the bare repo, the one
    // place the commit is guaranteed to be whichever machine executed (a
    // runner pushed it there; the server executor's commitWork did too).
    // Recorded as a durable system turn so every viewer of the chat — live
    // watchers, later readers — sees which files changed and by how much.
    if (sha) {
      changes = await diffFilesBare(repoRef, input.baseSha, sha).catch(() => []);
      if (changes.length > 0) {
        const changesTurn = await appendMessage({
          runId,
          role: "system",
          body: formatChanges(changes),
        });
        broadcast({
          type: "run.turn", runId, seq: changesTurn.seq, role: "system",
          authorName: null, body: changesTurn.body, at: Date.now(),
        });
      }
    }

    const stat = sha
      ? await diffStatBare(repoRef, input.baseSha, sha).catch(() => null)
      : { added: 0, removed: 0 };
    await finishRun(runId, {
      status,
      resultSha: sha,
      exitCode: input.code,
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
        prompt: input.userPrompt,
        reply: trimmedOut,
        changed: sha !== null,
        // Only work with a publish step waits for that approval; imported
        // repos and personal rooms ingest at completion, their only approval.
        publishGated: publishFlowExists,
      });
    }
  } catch {
    // The run record is best-effort; the live stream already succeeded.
  }

  // Refresh the AI's understanding of the repo it just changed — but only
  // where completion *is* the approval: imported repos, and personal rooms
  // outside any project. A project room's fork waits for publish, exactly
  // like its staged memories (see repo-context.ts for the full contract).
  if (sha && !publishFlowExists) {
    void ensureRepoContext(repoRef);
  }

  return { status, changes };
}
