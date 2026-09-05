/**
 * The agent-run worker.
 *
 * A standalone process — deliberately *not* part of the Next.js server — that
 * pulls agent-run jobs off the queue and executes them. This is the whole point
 * of the decoupling: the CPU-heavy, occasionally-runaway spawned CLI lives here,
 * so a job that spikes to 100% CPU or leaks a child process degrades this
 * process, never the web server every user shares.
 *
 * Run it with `npm run worker` (or `worker:dev` to reload on edit). It needs
 * `REDIS_URL` (the queue and the streaming bridge both require it) and the same
 * `MULTIPLAYER_AI_DATA` and `DATABASE_URL` the web server uses — in this first
 * slice web and worker share one machine and one data root, so the worker's
 * `ensureWork`/`commitWork` operate on the very same git state.
 */
import { executeAgentRun } from "../app/lib/ai/execute";
import { publishRunEvent } from "../app/lib/ai/run-stream";
import { createRunWorker, queueEnabled } from "../app/lib/queue";

if (!queueEnabled()) {
  console.error(
    "The agent worker needs AGENT_WORKER=1 and REDIS_URL. Without them the web server runs turns inline and no worker is required.",
  );
  process.exit(1);
}

const worker = createRunWorker((job) =>
  // Each live event is forwarded to the per-run Redis channel the web process
  // is subscribed to; everything durable (commit, turns, finishRun, watcher
  // broadcasts) is handled inside executeAgentRun, identically to inline mode.
  executeAgentRun(job, (event) => {
    void publishRunEvent(job.runId, event).catch(() => {});
  }),
);

worker.on("ready", () => console.log("agent worker ready; waiting for jobs"));
worker.on("active", (job) => console.log(`run ${job.data.runId}: started (${job.data.agentId})`));
worker.on("completed", (job) => console.log(`run ${job.data.runId}: done`));
worker.on("failed", (job, err) =>
  console.error(`run ${job?.data.runId ?? "?"}: failed — ${err?.message ?? err}`),
);
worker.on("error", (err) => console.error("worker error:", err));

// Graceful shutdown: stop accepting new jobs and let an in-flight one finish, so
// a deploy doesn't SIGKILL a run mid-commit and orphan its child process.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    console.log(`${signal} received; draining worker…`);
    await worker.close();
    process.exit(0);
  });
}
