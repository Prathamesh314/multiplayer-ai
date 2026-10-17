import { permissionAsker } from "./permissions";
import { ATTACHMENT_ROOT, placeAttachments } from "./attachments";
import { ActivityOutbox } from "./activity-outbox";
/*
 * The multicode-ai runner: agents on your machine, rooms in the cloud.
 *
 * A headless daemon that turns this computer into the execution plane of
 * docs/local-execution.md. It pairs once, then loops: heartbeat, claim the
 * next run addressed to its owner, materialize the repo over smart-HTTP,
 * spawn the agent CLI with this machine's own logins, stream the output up,
 * push the commit, and report completion. Every turn its user starts runs at
 * once unless `--parallel` sets a personal cap; the server only hands out
 * overlapping turns for separate worktrees (other rooms, or parallel chats). Every durable effect happens
 * server-side — this process holds no state beyond its config and checkouts.
 *
 *   npm run runner -- pair --server https://… --code RN-XXXX-XXXX [--name "My Mac"]
 *   npm run runner -- start [--once] [--parallel 3]
 *   npm run runner -- workspaces prune [--apply]
 *
 * `--once` processes a single job and exits — CI and smoke tests use it.
 */

import { storeCompletion, deliverCompletions } from "./outbox";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { agentById } from "../app/lib/ai/catalog";
import type { AiRunEvent } from "../app/lib/ai/run-events";
import { pairDevice, RunnerApi, permanentRunnerFailure } from "./api";
import { defaultDataDir, loadConfig, saveConfig, configPath, resolveWorkspacesDir, resolveMaxParallel, resolveCopyIgnoredFiles } from "./config";
import { runAgentLocally } from "./execute";
import { listLocalWorkspaces } from "./workspace-layout";
import { RunnerGit } from "./git";
import { TerminalHost } from "./terminal";
import { WakeSignal } from "./signals";

const HEARTBEAT_MS = 15_000;
/** Events buffer briefly so a chatty agent becomes a few requests per second. */
const FLUSH_MS = 1000;

const log = (message: string) => console.log(`[runner] ${message}`);
let stopping = false;
const stopSignal = new AbortController();
const jobsReady = new WakeSignal();
const inputsReady = new WakeSignal();
const stop = () => { stopping = true; stopSignal.abort(); jobsReady.wake(); inputsReady.wake(); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
const desktopPort = (process as NodeJS.Process & {
  parentPort?: { on: (event: string, listener: (event: { data?: { type?: string } }) => void) => void };
}).parentPort;
desktopPort?.on("message", event => {
  if (event.data?.type === "shutdown") stop();
});

function flag(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

/**
 * One pass at a time, with a trailing re-run: concurrent turns and the main
 * loop share deliveries without double-posting, and a caller always waits
 * for a pass that started after it asked.
 */
function serialized(task: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | null = null;
  let again = false;
  return () => {
    again = true;
    running ??= (async () => {
      let failure: unknown = null;
      while (again) {
        again = false;
        try { await task(); } catch (cause) { failure = cause; }
      }
      if (failure) throw failure;
    })().finally(() => { running = null; });
    return running;
  };
}

type Deliveries = { checkpoints: () => Promise<void>; completions: () => Promise<void> };

async function pair(): Promise<void> {
  const server = (flag("server") ?? "").replace(/\/$/, "");
  const code = flag("code") ?? "";
  if (!server || !code) {
    console.error("Usage: multicode-ai-runner pair --server <url> --code <RN-XXXX-XXXX> [--name <name>]");
    process.exit(1);
  }
  const name = flag("name") ?? hostname();
  const paired = await pairDevice({ server, code, name });
  saveConfig({ server, token: paired.token, name, dataDir: flag("data") ?? defaultDataDir(), workspacesDir: resolveWorkspacesDir(flag("workspaces")) });
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
  dataDir: string,
  git: RunnerGit,
  activity: ActivityOutbox,
  job: NonNullable<Awaited<ReturnType<RunnerApi["claim"]>>>,
  deliveries: Deliveries,
): Promise<void> {
  const repoRef = job.repoId ?? job.sessionId;
  const spec = agentById(job.agentId);
  log(`run ${job.runId}: claimed (${job.agentId} on ${repoRef}${job.isolation === "isolated" ? ", parallel chat" : ""})`);

  let queue: AiRunEvent[] = [];
  let sequence = 0;
  const flush = () => {
    if (!queue.length) return;
    activity.store(job.turnId, ++sequence, queue);
    queue = [];
    void activity.deliver(api);
  };
  const timer = setInterval(flush, FLUSH_MS);
  // Renew only the execution owned by this process. Reconnecting a restarted
  // daemon must never keep an abandoned execution's lease alive.
  const execution = new AbortController();
  const abortExecution = () => execution.abort();
  stopSignal.signal.addEventListener("abort", abortExecution, { once: true });
  if (stopSignal.signal.aborted) abortExecution();
  let renewedAt = Date.now(), renewing = false;
  const leaseTimer = setInterval(() => {
    if (renewing) return;
    renewing = true;
    void api.postEvents(job.turnId, []).then(() => { renewedAt = Date.now(); }).catch(cause => {
      if (Date.now() - renewedAt > 40_000 || permanentRunnerFailure(cause)) execution.abort();
    }).finally(() => { renewing = false; });
  }, 15_000);
  const emit = (event: AiRunEvent) => {
    // Bound a batch even when a CLI emits a large chunk in one callback.
    if ("d" in event && event.d.length > 16000) {
      for (let offset = 0; offset < event.d.length; offset += 16000) emit({ ...event, d: event.d.slice(offset, offset + 16000) });
      return;
    }
    if (queue.length >= 50 || Buffer.byteLength(JSON.stringify([...queue, event])) > 128 * 1024) flush();
    queue.push(event);
  };

  let code: number | null = null;
  let output = "";
  let errOutput = "";
  let ms = 0;
  let sha: string | null = null;

  try {
    if (!spec) throw new Error(`This machine doesn't know the agent "${job.agentId}".`);

    sha = await git.withWorkspace(job, async (workspace) => {
      emit({ t: "start", agent: spec.bin, cwd: workspace.path, runId: job.runId });
      // Before the first checkpoint, so attachments are already excluded from it.
      const attached = await placeAttachments(workspace.path, job.turnId, job.attachments, id => api.attachment(job.turnId, id, execution.signal));
      if (attached) emit({ t: "notice", message: `${attached} attached file${attached === 1 ? "" : "s"} ready in ${ATTACHMENT_ROOT}/` });
      let checkpointing = Promise.resolve();
      const checkpoint = () => { checkpointing = checkpointing.then(() => workspace.checkpoint()).then(() => deliveries.checkpoints()).catch(cause => emit({ t: "notice", message: `Checkpoint pending: ${String(cause)}` })); };
      checkpoint();
      const snapshotTimer = setInterval(checkpoint, 30_000);
      let result;
      try { result = await runAgentLocally({
        spec,
        prompt: job.agentPrompt,
        model: job.model,
        effort: job.effort,
        cwd: workspace.path,
        onEvent: emit,
        signal: execution.signal,
        allowedTools: job.allowedTools,
        permissions: permissionAsker(api.permissions(job.turnId), job.allowedTools, {
          signal: execution.signal,
          onWaiting: request => emit({ t: "notice", message: `Waiting for you to allow in the chat: ${request.title}` }),
        }),
        inputs: {
          claim: closeIfEmpty => api.input(job.turnId, { kind: "claim", claimId: randomUUID(), closeIfEmpty }),
          acknowledge: async id => { await api.input(job.turnId, { kind: "ack", id }); },
          uncertain: async (id, error) => { await api.input(job.turnId, { kind: "uncertain", id, error }); },
          subscribe: listener => inputsReady.subscribe(listener),
        },
      }); } finally { clearInterval(snapshotTimer); checkpoint(); await checkpointing; }
      code = result.code;
      output = result.output;
      errOutput = result.errOutput;
      ms = result.ms;

      return workspace.commitAndPush(`${spec.bin}: agent run`, job.author);
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    emit({ t: "err", d: `${message}\n` });
    errOutput = errOutput ? `${errOutput}\n${message}` : message;
    code = 1;
  } finally {
    clearInterval(timer);
    clearInterval(leaseTimer);
    stopSignal.signal.removeEventListener("abort", abortExecution);
    flush();
    await activity.deliver(api);
  }

  await storeCompletion(dataDir, job.turnId, { code, resultSha: sha, output, errOutput, ms });
  await deliveries.completions();
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
          maxParallel: undefined,
          copyIgnoredFiles: undefined,
          terminal: undefined,
        }
      : loadConfig();
  if (!config) {
    console.error(`No config at ${configPath()} — run \`multicode-ai-runner pair\` first.`);
    process.exit(1);
  }

  const api = new RunnerApi(config.server, config.token);
  const activity = new ActivityOutbox(config.dataDir, config.server, config.token);
  const workspacesDir = resolveWorkspacesDir(flag("workspaces") ?? ("workspacesDir" in config ? config.workspacesDir : undefined));
  const git = new RunnerGit(config.server, config.token, config.dataDir, workspacesDir, {
    copyIgnoredFiles: resolveCopyIgnoredFiles(process.env.RUNNER_COPY_IGNORED ?? config.copyIgnoredFiles),
  });
  log(`worktrees: ${workspacesDir}`);
  const once = process.argv.includes("--once");
  const maxParallel = once ? 1 : resolveMaxParallel(flag("parallel"), process.env.RUNNER_MAX_PARALLEL, config.maxParallel);
  const deliveries: Deliveries = {
    checkpoints: serialized(() => git.deliverCheckpoints(api)),
    completions: serialized(() => deliverCompletions(config.dataDir, api)),
  };
  const idleCheckpoints = serialized(() => git.checkpointIdleWorkspaces());
  const sync = async () => {
    await idleCheckpoints();
    await deliveries.checkpoints();
    await activity.deliver(api);
    await deliveries.completions();
  };

  // Terminals for this computer's owner, in their chats' worktrees. On unless
  // the owner turns them off (--no-terminal, RUNNER_TERMINAL=0, "terminal": false).
  const terminalsOn = !process.argv.includes("--no-terminal") && process.env.RUNNER_TERMINAL !== "0" && config.terminal !== false;
  const terminals = terminalsOn ? new TerminalHost(report => api.terminal(report), open => git.terminalDirectory(open)) : null;
  api.supportsTerminal = !!terminals;
  log(terminals ? "terminals: on (in your chats' worktrees)" : "terminals: off");

  await api.heartbeat(); // fail fast on a revoked token
  log(`online as "${config.name}" against ${config.server}${once ? " (single job)" : ""}`);

  const heartbeat = setInterval(() => void api.heartbeat(true).catch(() => {}), HEARTBEAT_MS);
  heartbeat.unref?.();

  let fatal: Error | null = null;
  const signals = (async () => {
    while (!stopping) {
      try {
        await api.signals(stopSignal.signal, (type, data) => {
          if (type.startsWith("terminal.")) { terminals?.handle(type, data); return; }
          if (type === "ready" || type === "runner.work" || type === "resync" || type === "devices.changed") jobsReady.wake();
          if (type === "ready" || type === "run.inputs" || type === "resync") inputsReady.wake();
        });
      } catch (cause) {
        if (stopSignal.signal.aborted) break;
        if (cause instanceof Error && cause.message.includes("re-pair")) { fatal = cause; stop(); break; }
      }
      if (!stopping) await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); stopSignal.signal.removeEventListener("abort", done); resolve(); };
        const timer = setTimeout(done, 3000);
        stopSignal.signal.addEventListener("abort", done, { once: true });
      });
    }
  })();

  let maintenanceBusy = false;
  const maintenance = setInterval(() => {
    if (maintenanceBusy || stopping) return;
    maintenanceBusy = true;
    void sync().catch(cause => log(`Sync pending: ${String(cause)}`)).finally(() => { maintenanceBusy = false; });
  }, 30_000);

  log(Number.isFinite(maxParallel) ? `up to ${maxParallel} turn${maxParallel === 1 ? "" : "s"} at once` : "runs every task you start, with no cap");
  const running = new Set<Promise<void>>();
  while (!stopping) {
    const revision = jobsReady.version();
    await sync().catch(cause => log(`Sync pending: ${String(cause)}`));
    if (running.size >= maxParallel) {
      // A finished turn frees a slot; claim again then.
      await Promise.race(running);
      continue;
    }
    let job: Awaited<ReturnType<RunnerApi["claim"]>> = null;
    try {
      job = await api.claim(0);
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
    if (!job) { await jobsReady.wait(revision, stopSignal.signal); continue; }

    const claimed = job;
    const turn: Promise<void> = processJob(api, config.dataDir, git, activity, claimed, deliveries).catch((cause) =>
      console.error(`[runner] run ${claimed.runId} failed to report: ${String(cause)}`),
    ).finally(() => { running.delete(turn); });
    running.add(turn);
    if (once) { await turn; break; }
  }
  // Stopping aborts each turn's agent; let them record their completions.
  await Promise.allSettled(running);
  clearInterval(maintenance);
  clearInterval(heartbeat);
  terminals?.closeAll();
  stop();
  await signals;
  if (fatal) throw fatal;
  if (desktopPort) process.exit(0);
}

/**
 * Worktrees of parallel chats that were merged, discarded or archived. Lists
 * them by default; `--apply` removes only clean ones whose commits the server
 * already holds. Room worktrees are never touched.
 */
async function prune(): Promise<void> {
  const config = loadConfig();
  if (!config) throw new Error(`No config at ${configPath()} — run \`multicode-ai-runner pair\` first.`);
  const api = new RunnerApi(config.server, config.token);
  const apply = process.argv.includes("--apply");
  const { userId, finishedChats } = await api.workspaces();
  const git = new RunnerGit(config.server, config.token, flag("data") ?? config.dataDir, resolveWorkspacesDir(flag("workspaces") ?? config.workspacesDir));
  const results = await git.pruneChatWorkspaces(userId, new Set(finishedChats), apply);
  if (!results.length) { log("No finished parallel-chat worktrees."); return; }
  for (const entry of results) {
    const state = entry.removable ? (apply ? "removed" : "can be removed") : `kept: ${entry.reason}`;
    log(`${entry.chat} — ${entry.path} (${state})`);
  }
  if (!apply && results.some(entry => entry.removable)) log("Run again with --apply to remove them. Ignored files in them, such as installed dependencies, are deleted too.");
}

const command = process.argv[2];
if (command === "--help" || command === "-h" || command === "help") {
  console.log("Usage: multicode-ai-runner <pair|start|workspaces> [options]\n\n" +
    "  pair --server <url> --code <RN-XXXX-XXXX>  Connect this computer\n" +
    "  start                                    Run your AI tasks (Ctrl+C to stop)\n" +
    "  workspaces [--json]                       List local worktrees\n" +
    "  workspaces prune [--apply]                Remove finished parallel-chat worktrees\n" +
    "  --version                                Print the runner version\n\n" +
    "Options: --name <name>, --workspaces <directory>, --data <directory>, --parallel <n> (optional cap), --no-terminal\n" +
    "Works from any directory. No application source checkout is needed.");
} else if (command === "--version" || command === "-v") {
  console.log(process.env.MULTIPLAYER_RUNNER_VERSION ?? "development");
} else if (command === "workspaces" && process.argv[3] === "prune") {
  void prune().catch(cause => { console.error(cause instanceof Error ? cause.message : String(cause)); process.exitCode = 1; });
} else if (command === "workspaces") {
  void listLocalWorkspaces(flag("data") ?? loadConfig()?.dataDir ?? defaultDataDir()).then(workspaces => {
    if (process.argv.includes("--json")) console.log(JSON.stringify(workspaces, null, 2));
    else if (workspaces.length) console.table(workspaces);
    else log("No local worktrees yet. They are created when a repository first runs on this computer.");
  }).catch(cause => { console.error(cause instanceof Error ? cause.message : String(cause)); process.exitCode = 1; });
} else if (command === "pair") {
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
  console.error("Usage: multicode-ai-runner <pair|start|workspaces> [--workspaces <directory>] [flags]");
  process.exit(1);
}
