import type { Checkpoint } from "../runner/checkpoint-types";
/**
 * The live wire format of one agent run — the newline-delimited JSON the run
 * endpoint streams to the driver's browser.
 *
 * This type used to live in the run route. It moved here because there are now
 * two producers of it: the route itself (inline, when there is no worker) and
 * the worker (which publishes these over Redis for the route to forward). A
 * shared definition keeps those two from drifting.
 *
 *  - `start`  the agent process began; carries what and where.
 *  - `out`    a chunk of the reply. Also saved in activity batches; accumulated and
 *             stored as one consolidated turn at the end.
 *  - `think`  a chunk of the model's thinking. Live-only, never stored.
 *  - `act`    a chunk of tool activity, saved for shared history.
 *  - `err`    a chunk of stderr / an error message.
 *  - `notice` an out-of-band message to show the runner (limits, timeouts).
 *  - `exit`   terminal: the exit code, elapsed time, and the commit it produced.
 */
export type AiRunEvent =
  | { t: "start"; agent: string; cwd: string; runId: string }
  | { t: "out"; d: string }
  | { t: "think"; d: string }
  | { t: "act"; d: string }
  | { t: "err"; d: string }
  | { t: "notice"; message: string }
  | {
      t: "exit";
      code: number | null;
      ms: number;
      headSha: string | null;
      committed: boolean;
      /** Per-file line deltas of the run's commit, when it produced one. */
      changes?: { path: string; added: number; removed: number }[];
    };

/**
 * Everything a worker needs to run one turn, and nothing it doesn't.
 *
 * Crucially this is plain data: the agent's `bin`, `promptArgs`, and
 * `createStreamParser` are *functions* on the catalog spec and cannot be
 * serialised into a Redis job — so the job carries the `agentId` and the worker
 * rebuilds them with `agentById`. The prompt here is the fully-assembled one
 * (context and memory already woven in by the web layer); `userPrompt` is the
 * raw text the person typed, kept only for the shared-memory ingest at the end.
 */
export type AgentRunJob = {
  turnId: string;
  userId: string;
  controlVersion: number;
  sessionId: string;
  runId: string;
  /**
   * The room repo the run works on, or null for the room's own project fork.
   * The executor derives every repo path from this (falling back to the
   * session id), so an imported repo reuses the whole git layer unchanged.
   */
  repoId: string | null;
  /** Project grouping only; never used as the repository/cache identity. */
  projectId?: string | null;
  /** Repository identity for local cache sharing; never inferred from projectId. */
  projectRepositoryId?: string | null;
  /** Display labels only; the runner sanitizes and pins local folder names. */
  restoreCheckpoint?: Checkpoint;
  workspaceNames?: { repository: string; room: string; chat?: string };
  /** HEAD when the run was enqueued: the base the working copy is prepared at. */
  baseSha: string;
  /**
   * Set only for an isolated chat: `baseSha` is the tip of `chatBranch`, not of
   * the room branch, and the runner prepares a worktree of the chat's own.
   * Runners that do not understand this never claim the job (runner/jobs.ts).
   */
  isolation?: "isolated";
  chatBranch?: string;
  agentId: string;
  /** The assembled argv prompt (already budgeted and woven). */
  agentPrompt: string;
  /**
   * Files attached to this message. The runner downloads each one to `path`
   * (relative to the worktree, under `.multicode/attachments/`, excluded from
   * Git) before the agent starts, and checks its size and sha256. Runners that
   * cannot do this never claim the job (runner/jobs.ts).
   */
  attachments?: { id: string; path: string; size: number; sha256: string }[];
  model?: string;
  effort?: string;
  /** Attributes the auto-commit, exactly as the inline path always has. */
  author: { name: string; email: string };
  /** The raw prompt, for the post-run shared-memory ingest only. */
  userPrompt: string;
};
