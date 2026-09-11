import { failTurn } from "../app/lib/ai/turns";
/**
 * The background worker process.
 *
 * A standalone process — deliberately not part of the Next.js server — that
 * runs two independent background jobs, each gated by its own flag:
 *
 *  - Agent runs (AGENT_WORKER=1): pulls agent-run jobs and executes the CLI, so
 *    a runaway spawn degrades this process, never the web server.
 *  - Memory consolidation (MEMORY_CONSOLIDATION=1): the debounced "sleep" pass
 *    that consolidates a room's memories once it goes quiet.
 *
 * Run it with `npm run worker` (or `worker:dev`). It needs `REDIS_URL` and the
 * same `MULTIPLAYER_AI_DATA` / `DATABASE_URL` the web server uses.
 */
import { executeAgentRun } from "../app/lib/ai/execute";
import { drainStaged } from "../app/lib/ai/memory-staging";
import { runSleep } from "../app/lib/ai/mnemosyne";
import { publishRunEvent } from "../app/lib/ai/run-stream";
import { roomBank } from "../app/lib/ai/shared-memory";
import { createRunWorker, queueEnabled } from "../app/lib/queue";
import {
  consolidationEnabled,
  createConsolidationWorker,
} from "../app/lib/queue/consolidation";

const closers: Array<() => Promise<void>> = [];

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

if (consolidationEnabled()) {
  const consolidator = createConsolidationWorker(async (sessionId) => {
    // The drained buffer is the app-side record of what landed since the last
    // pass — used to skip a no-op sleep and to log. The actual input to `sleep`
    // is the sidecar's own working memory (populated by `remember` on ingest).
    const staged = await drainStaged(sessionId);
    if (staged.length === 0) {
      console.log(`consolidate ${sessionId}: nothing staged, skipping`);
      return;
    }
    const ok = await runSleep(roomBank(sessionId));
    console.log(`consolidate ${sessionId}: ${staged.length} exchange(s) → sleep ${ok ? "ok" : "skipped/failed"}`);
  });
  consolidator.on("ready", () => console.log("consolidation worker ready; waiting for jobs"));
  consolidator.on("error", (err) => console.error("consolidation worker error:", err));
  closers.push(() => consolidator.close());
}

if (closers.length === 0) {
  console.error(
    "Nothing to do: set AGENT_WORKER=1 (needs REDIS_URL) for agent runs and/or MEMORY_CONSOLIDATION=1 for memory consolidation.",
  );
  process.exit(1);
}

// Graceful shutdown: stop accepting new jobs and let in-flight ones finish, so a
// deploy doesn't SIGKILL a run mid-commit or a sleep mid-consolidation.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    console.log(`${signal} received; draining workers…`);
    await Promise.all(closers.map((close) => close().catch(() => {})));
    process.exit(0);
  });
}
