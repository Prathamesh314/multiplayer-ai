import { failTurn } from "../app/lib/ai/turns";
import { indexNextRepoJob, embedPendingRepoChunks } from "../app/lib/knowledge/repo-context";
import { processMemoryJob } from "../app/lib/knowledge/memory-jobs";
/**
 * The background worker process.
 *
 * A standalone process — deliberately not part of the Next.js server — that
 * runs independent background jobs:
 *
 *  - Agent runs (AGENT_WORKER=1): pulls agent-run jobs and executes the CLI, so
 *    a runaway spawn degrades this process, never the web server.
 *  - Memory jobs (DATABASE_URL set): retryable indexing, optional extraction
 *    into proposals, and recovery of publication approvals.
 *  - Repository indexing (DATABASE_URL set): durable snapshot requests and
 *    missing pgvector embeddings, independent of the conversation sidecar.
 *
 * Run it with `npm run worker` (or `worker:dev`). It needs the same
 * MULTIPLAYER_AI_DATA / DATABASE_URL as web; Redis is only needed for agent runs.
 */
import { executeAgentRun } from "../app/lib/ai/execute";
import { publishRunEvent } from "../app/lib/ai/run-stream";
import { createRunWorker, queueEnabled } from "../app/lib/queue";
import nextEnv from "@next/env";

nextEnv.loadEnvConfig(process.cwd(), process.env.NODE_ENV !== "production");

const closers: Array<() => Promise<void>> = [];

// Poll durable indexing requests and missing vectors, never scan repositories.
// A failed transaction leaves its request ready for a later retry.
if (process.env.DATABASE_URL) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> = Promise.resolve();
  const tick = () => {
    running = (async () => {
      let delay = 2000;
      try {
        const indexed = await indexNextRepoJob();
        const embedded = await embedPendingRepoChunks();
        if (indexed || embedded) delay = 10;
      } catch (cause) {
        delay = 30_000;
        console.warn("Repo context worker retry scheduled", cause instanceof Error ? cause.message : cause);
      }
      if (!stopped) timer = setTimeout(tick, delay);
    })();
  };
  tick();
  closers.push(async () => { stopped = true; clearTimeout(timer); await running; });
}

if (queueEnabled()) {
  const runWorker = createRunWorker((job) =>
    // Live events go to the per-run Redis channel the web process forwards;
    // everything durable is handled inside executeAgentRun, identically to
    // inline mode.
    executeAgentRun(job, (event) => {
      void publishRunEvent(job.turnId, event).catch(() => {});
    }),
  );
  runWorker.on("ready", () => console.log("agent worker ready; waiting for jobs"));
  runWorker.on("active", (job) => console.log(`run ${job.data.runId}: started (${job.data.agentId})`));
  runWorker.on("completed", (job) => console.log(`run ${job.data.runId}: done`));
  runWorker.on("failed", (job, err) => {
    console.error(`run ${job?.data.runId ?? "?"}: failed — ${err?.message ?? err}`);
    if (job) void failTurn(job.data.turnId, err?.message ?? "Worker failed").catch(() => {});
  });
  runWorker.on("error", (err) => console.error("agent worker error:", err));
  closers.push(() => runWorker.close());
}

// Independent loop: repository/embedding outages cannot starve memory jobs.
if (process.env.DATABASE_URL) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> = Promise.resolve();
  const tick = () => {
    running = (async () => {
      let worked = false;
      try { worked = await processMemoryJob(); }
      catch (cause) { console.warn("Memory worker will retry", cause instanceof Error ? cause.message : cause); }
      if (!stopped) timer = setTimeout(tick, worked ? 10 : 2000);
    })();
  };
  tick();
  closers.push(async () => { stopped = true; clearTimeout(timer); await running; });
}

if (closers.length === 0) {
  console.error(
    "Nothing to do: set DATABASE_URL for memory/repo indexing, or AGENT_WORKER=1 (needs REDIS_URL) for agent runs.",
  );
  process.exit(1);
}

// Graceful shutdown: stop accepting new jobs and let in-flight ones finish, so a
// deploy doesn't SIGKILL a run mid-commit or a memory delivery mid-request.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    console.log(`${signal} received; draining workers…`);
    await Promise.all(closers.map((close) => close().catch(() => {})));
    process.exit(0);
  });
}
