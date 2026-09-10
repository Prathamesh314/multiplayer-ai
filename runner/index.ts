/*
 * The multiplayer-ai runner: agents on your machine, rooms in the cloud.
 *
 * A headless daemon that turns this computer into the execution plane of
 * docs/local-execution.md. It pairs once, then loops: heartbeat, claim the
 * next run addressed to its owner, materialize the repo over smart-HTTP,
 * spawn the agent CLI with this machine's own logins, stream the output up,
 * push the commit, and report completion. Every durable effect happens
 * server-side — this process holds no state beyond its config and checkouts.
 *
 *   npm run runner -- pair --server https://… --code RN-XXXX-XXXX [--name "My Mac"]
 *   npm run runner -- start [--once]
 *
 * `--once` processes a single job and exits — CI and smoke tests use it.
 */

import { hostname } from "node:os";
import { agentById } from "../app/lib/ai/catalog";
import type { AiRunEvent } from "../app/lib/ai/run-events";
import { pairDevice, RunnerApi } from "./api";
import { defaultDataDir, loadConfig, saveConfig, configPath } from "./config";
import { runAgentLocally } from "./execute";
import { RunnerGit } from "./git";

const HEARTBEAT_MS = 15_000;
const CLAIM_WAIT_MS = 20_000;
/** Events buffer briefly so a chatty agent becomes a few requests per second. */
const FLUSH_MS = 250;

const log = (message: string) => console.log(`[runner] ${message}`);

function flag(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

async function pair(): Promise<void> {
  const server = (flag("server") ?? "").replace(/\/$/, "");
  const code = flag("code") ?? "";
  if (!server || !code) {
    console.error("Usage: runner pair --server <url> --code <RN-XXXX-XXXX> [--name <name>]");
    process.exit(1);
  }
  const name = flag("name") ?? hostname();
  const paired = await pairDevice({ server, code, name });
  saveConfig({ server, token: paired.token, name, dataDir: flag("data") ?? defaultDataDir() });
  log(`paired as "${name}" (device ${paired.deviceId})`);
  log(`config written to ${configPath()}`);
}

/**
 * One claimed job, end to end. Failures inside the run surface as err frames
 * and a non-zero completion — never a crash of the loop: the next job must
 * not depend on this one's luck.
 */
async function processJob(
  api: RunnerApi,
  git: RunnerGit,
  job: NonNullable<Awaited<ReturnType<RunnerApi["claim"]>>>,
): Promise<void> {
  const repoRef = job.repoId ?? job.sessionId;
  const spec = agentById(job.agentId);
  log(`run ${job.runId}: claimed (${job.agentId} on ${repoRef})`);

  // The up-stream: order-preserving batches on a short timer. A send failure
  // drops that batch, not the run — /complete carries the full output anyway.
  let queue: AiRunEvent[] = [];
  let sending = Promise.resolve();
  const flush = () => {
    if (queue.length === 0) return;
    const batch = queue;
    queue = [];
    sending = sending.then(() => api.postEvents(job.runId, batch).catch(() => {}));
  };
  const timer = setInterval(flush, FLUSH_MS);
  const emit = (event: AiRunEvent) => {
    queue.push(event);
  };

  let code: number | null = null;
  let output = "";
  let errOutput = "";
  let ms = 0;
  let sha: string | null = null;

  try {
    if (!spec) throw new Error(`This machine doesn't know the agent "${job.agentId}".`);

    const cwd = await git.ensureWork(repoRef, job.baseSha);
    emit({ t: "start", agent: spec.bin, cwd, runId: job.runId });

    const result = await runAgentLocally({
      spec,
      prompt: job.agentPrompt,
      model: job.model,
      effort: job.effort,
      cwd,
      onEvent: emit,
    });
    code = result.code;
    output = result.output;
    errOutput = result.errOutput;
    ms = result.ms;

    sha = await git.commitAndPush(repoRef, `${spec.bin}: agent run`, job.author);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    emit({ t: "err", d: `${message}\n` });
    errOutput = errOutput ? `${errOutput}\n${message}` : message;
    code = code ?? 1;
  } finally {
    clearInterval(timer);
    flush();
    await sending;
  }

  await api.complete(job.runId, { code, resultSha: sha, output, errOutput, ms });
  log(`run ${job.runId}: ${code === 0 ? "completed" : "failed"}${sha ? ` → ${sha.slice(0, 8)}` : ""}`);
}

async function start(): Promise<void> {
  const overrides = { server: flag("server"), token: flag("token") };
  const config =
    overrides.server && overrides.token
      ? {
          server: overrides.server.replace(/\/$/, ""),
          token: overrides.token,
          name: flag("name") ?? hostname(),
          dataDir: flag("data") ?? defaultDataDir(),
        }
      : loadConfig();
  if (!config) {
    console.error(`No config at ${configPath()} — run \`runner pair\` first.`);
    process.exit(1);
  }

  const api = new RunnerApi(config.server, config.token);
  const git = new RunnerGit(config.server, config.token, config.dataDir);
  const once = process.argv.includes("--once");

  await api.heartbeat(); // fail fast on a revoked token
  log(`online as "${config.name}" against ${config.server}${once ? " (single job)" : ""}`);

  const heartbeat = setInterval(() => void api.heartbeat().catch(() => {}), HEARTBEAT_MS);
  heartbeat.unref?.();

  for (;;) {
    let job: Awaited<ReturnType<RunnerApi["claim"]>> = null;
    try {
      job = await api.claim(CLAIM_WAIT_MS);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (message.includes("re-pair")) {
        console.error(`[runner] ${message}`);
        process.exit(1);
      }
      // The server being briefly unreachable is a wait, not a crash.
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      continue;
    }
    if (!job) continue;

    await processJob(api, git, job).catch((cause) =>
      console.error(`[runner] run ${job!.runId} failed to report: ${String(cause)}`),
    );
    if (once) break;
  }
  clearInterval(heartbeat);
}

const command = process.argv[2];
if (command === "pair") {
  void pair().catch((cause) => {
    console.error(`[runner] ${cause instanceof Error ? cause.message : String(cause)}`);
    process.exit(1);
  });
} else if (command === "start" || command === undefined) {
  void start().catch((cause) => {
    console.error(`[runner] ${cause instanceof Error ? cause.message : String(cause)}`);
    process.exit(1);
  });
} else {
  console.error("Usage: runner <pair|start> [flags]");
  process.exit(1);
}
