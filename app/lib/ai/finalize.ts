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

import { events } from "../events";
import { diffStatBare } from "../session/repo";
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

/** The run's terminal status, as the transcript and the room will record it. */
export async function finalizeAgentRun(input: FinalizeInput): Promise<"completed" | "failed"> {
  const { sessionId, runId, repoId, sha } = input;
  const repoRef = repoId ?? sessionId;
  const status = input.code === 0 ? "completed" : "failed";

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
      await appendMessage({ runId, role: "system", body: trimmedErr });
    }
    // Against the bare repo, which is the one place the commit is guaranteed
    // to be whichever machine executed — a runner pushed it there, and the
    // server executor's commitWork did too. No lock: bare reads don't race.
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
        // Only the project fork has a publish step to approve its work;
        // an imported repo's exchanges ingest immediately.
        publishGated: repoId === null,
      });
    }
  } catch {
    // The run record is best-effort; the live stream already succeeded.
  }

  return status;
}
