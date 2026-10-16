import { indexNextRepoJob, embedPendingRepoChunks } from "../app/lib/knowledge/repo-context";
import { processMemoryJob } from "../app/lib/knowledge/memory-jobs";
/**
 * The background worker process.
 *
 * A standalone process — deliberately not part of the Next.js server — that
 * runs independent background jobs:
 *
 *  - Memory jobs (DATABASE_URL set): retryable indexing, optional extraction
 *    into proposals, and recovery of publication approvals.
 *  - Repository indexing (DATABASE_URL set): durable snapshot requests and
 *    missing pgvector embeddings, independent of the conversation sidecar.
 *
 * Run it with `npm run worker` (or `worker:dev`). It needs the same
 * MULTIPLAYER_AI_DATA / DATABASE_URL as web. It never runs AI agents: those run
 * only on members' own computers, through the desktop app or runner.
 */
import { loadEnvConfig } from "@next/env";
import { startTeamContext } from './team-context';
import { recoverAgentTurns } from '../app/lib/ai/recovery';
import { recoverStorageReservations, storageLimit } from '../app/lib/storage/accounting';

loadEnvConfig(process.cwd(), process.env.NODE_ENV !== "production");

const closers: Array<() => Promise<void>> = [];
if (process.env.DATABASE_URL) closers.push(startTeamContext());

// Storage recovery never blocks admission on another repository. A reservation
// remains charged until the resource's inherited kernel lock can be acquired.
if (process.env.DATABASE_URL && storageLimit()) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = Promise.resolve();
  const tick = () => {
    pending = recoverStorageReservations(60_000).then(() => {}, error => {
      console.warn("Storage recovery will retry", error instanceof Error ? error.message : error);
    }).finally(() => { if (!stopped) timer = setTimeout(tick, 60_000); });
  };
  tick();
  closers.push(async () => { stopped = true; clearTimeout(timer); await pending; });
}

// Independent, bounded recovery. Indexing outages cannot leave turns stranded.
if (process.env.DATABASE_URL) {
  let stopped=false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending=Promise.resolve();
  const tick=()=>{
    pending=recoverAgentTurns().then(()=>{},()=>{console.warn('AI recovery will retry.');}).finally(()=>{
      if(!stopped)timer=setTimeout(tick,10_000);
    });
  };
  tick();
  closers.push(async()=>{stopped=true;clearTimeout(timer);await pending;});
}

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
    "Nothing to do: set DATABASE_URL for memory and repository indexing.",
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
