import { Queue, Worker, type Job } from "bullmq";
import IORedis, { type Redis } from "ioredis";
import type { AgentRunJob } from "../ai/run-events";

/**
 * The agent-run job queue.
 *
 * This module is the *only* place `ioredis` and BullMQ exist. The rest of the
 * app keeps using the `node-redis` event bus and never learns a second client
 * is here — the surface is just `enqueueRun`, `createRunWorker`, and the
 * `queueEnabled` predicate. That boundary is deliberate: two Redis clients are
 * a fine price for a battle-tested queue, but only if they stay untangled.
 *
 * Why a real queue and not a hand-rolled Redis list: these jobs are
 * long-running, state-mutating remote code execution. Stalled-job detection and
 * the *absence* of accidental double-execution are load-bearing, and getting
 * those right by hand on the RCE path is more risk than one extra dependency.
 */
const QUEUE_NAME = "agent-runs";

/**
 * Whether runs go to a worker rather than executing inline.
 *
 * Deliberately an *explicit* opt-in, not merely "is Redis present": `REDIS_URL`
 * is set by default for presence (see `.env.example`), so keying the worker
 * topology off Redis alone would silently make every such dev need a running
 * worker or watch their runs hang. `AGENT_WORKER=1` is the switch; it needs
 * Redis too, since both the queue and the streaming bridge require it.
 */
export function queueEnabled(): boolean {
  return process.env.AGENT_WORKER === "1" && Boolean(process.env.REDIS_URL);
}

function redisUrl(): string {
  const url = process.env.REDIS_URL;
  if (!url) {
    // Callers gate on `queueEnabled()` first, so reaching here is a bug, not a
    // config gap — hence a throw rather than a silent no-op.
    throw new Error("REDIS_URL is required to use the agent-run queue.");
  }
  return url;
}

/**
 * A fresh ioredis connection. BullMQ requires `maxRetriesPerRequest: null` on
 * the connections it blocks on (BRPOPLPUSH), or it throws on start. Queue and
 * Worker get their own connections, as BullMQ recommends.
 */
function connection(): Redis {
  return new IORedis(redisUrl(), { maxRetriesPerRequest: null });
}

let queue: Queue<AgentRunJob> | null = null;

function getQueue(): Queue<AgentRunJob> {
  queue ??= new Queue<AgentRunJob>(QUEUE_NAME, { connection: connection() });
  return queue;
}

/**
 * Hand one turn to a worker.
 *
 * `jobId: runId` makes enqueue idempotent per run — a double-submit of the same
 * run cannot become two executing jobs. `attempts: 1` means **no automatic
 * retry**: re-running a turn that already half-mutated the working tree is
 * exactly the double-execution the queue exists to prevent, so a failure stays
 * failed and is surfaced, never silently replayed.
 */
export async function enqueueRun(job: AgentRunJob): Promise<void> {
  await getQueue().add("run", job, {
    jobId: job.turnId,
    attempts: 1,
    removeOnComplete: true,
    // Keep a bounded tail of failures for debugging; they are not replayed.
    removeOnFail: 50,
  });
}

/**
 * Start a worker that runs `handler` for each job.
 *
 * `maxStalledCount: 0` is the other half of the no-double-execution guarantee:
 * if a worker dies mid-run the job is marked *failed*, not moved back to be
 * retried. The session is left in whatever committed state the dead run reached
 * (never uncommitted, by the repo invariant) and the run row is reconciled to
 * failed — a stall never re-enters the working tree.
 *
 * Concurrency is per worker process; scale by running more processes.
 */
export function createRunWorker(
  handler: (job: AgentRunJob) => Promise<void>,
  options: { concurrency?: number } = {},
): Worker<AgentRunJob> {
  const concurrency =
    options.concurrency ?? Number(process.env.AGENT_WORKER_CONCURRENCY || "2");

  return new Worker<AgentRunJob>(
    QUEUE_NAME,
    async (job: Job<AgentRunJob>) => {
      await handler(job.data);
    },
    {
      connection: connection(),
      concurrency,
      maxStalledCount: 0,
      stalledInterval: 30_000,
    },
  );
}
