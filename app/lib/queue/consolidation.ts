import { Queue, Worker, type Job } from "bullmq";
import IORedis, { type Redis } from "ioredis";

/**
 * Legacy consolidation queue. No active worker consumes it; migration 030's
 * Postgres memory jobs and editor review replaced automatic consolidation.
 *
 * Instead of the sidecar's autonomous AUTO_SLEEP firing on its own cadence, we
 * drive consolidation: every ingested exchange (re)schedules a job that fires a
 * few minutes after the *last* exchange in a room, then triggers the sidecar's
 * `sleep`. Owning the trigger app-side is the point — it makes consolidation
 * observable and lets it later key off real signals (a build passing, a git
 * push, an explicit save) instead of a blind timer.
 *
 * Like the agent-run queue, ioredis lives only in the queue module; the surface
 * is scheduleConsolidation + createConsolidationWorker + consolidationEnabled.
 */
const QUEUE_NAME = "memory-consolidation";

/** Default debounce window: fire this long after a room goes quiet. */
const DEFAULT_DELAY_MS = 5 * 60 * 1000;

/**
 * On by explicit opt-in, exactly like the agent worker. Scheduling a job that no
 * consolidation worker consumes would pile up orphaned timers — so this stays
 * off unless `MEMORY_CONSOLIDATION=1` *and* Redis is configured, and the worker
 * process gates on the same predicate.
 */
export function consolidationEnabled(): boolean {
  return process.env.MEMORY_CONSOLIDATION === "1" && Boolean(process.env.REDIS_URL);
}

function connection(): Redis {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error("REDIS_URL is required for the consolidation queue.");
  return new IORedis(url, { maxRetriesPerRequest: null });
}

let queue: Queue<{ sessionId: string }> | null = null;

function getQueue(): Queue<{ sessionId: string }> {
  queue ??= new Queue<{ sessionId: string }>(QUEUE_NAME, { connection: connection() });
  return queue;
}

const jobIdFor = (sessionId: string) => `mem:${sessionId}`;

/**
 * (Re)arm the debounce timer for a room.
 *
 * The important subtlety: a duplicate `jobId` does NOT reschedule in BullMQ — it
 * dedupes and ignores the new job, so the timer would fire relative to the
 * *first* exchange, the opposite of a debounce. So we remove any pending job for
 * the room and add a fresh one. `remove` no-ops if the job is absent; if it is
 * currently *running*, remove fails and the re-add is dropped — acceptable,
 * since that run will consolidate what's already staged and the next exchange
 * re-arms the timer. Best-effort throughout: a failure here must never break a
 * run's ingest.
 */
export async function scheduleConsolidation(
  sessionId: string,
  delayMs: number = DEFAULT_DELAY_MS,
): Promise<void> {
  if (!consolidationEnabled()) return;
  const q = getQueue();
  const jobId = jobIdFor(sessionId);
  await q.remove(jobId).catch(() => {});
  await q
    .add(
      "consolidate",
      { sessionId },
      { jobId, delay: delayMs, removeOnComplete: true, removeOnFail: 20 },
    )
    .catch(() => {});
}

export function createConsolidationWorker(
  handler: (sessionId: string) => Promise<void>,
  options: { concurrency?: number } = {},
): Worker<{ sessionId: string }> {
  return new Worker<{ sessionId: string }>(
    QUEUE_NAME,
    async (job: Job<{ sessionId: string }>) => {
      await handler(job.data.sessionId);
    },
    {
      connection: connection(),
      concurrency: options.concurrency ?? Number(process.env.MEMORY_CONSOLIDATION_CONCURRENCY || "2"),
    },
  );
}
