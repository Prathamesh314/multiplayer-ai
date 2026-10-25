import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { agentById } from "../app/lib/ai/catalog.ts";
import { gitCommand } from "../app/lib/git/command.ts";
import { runAgentLocally } from "../runner/execute.ts";
import { runCodexSession } from "../runner/codex-session.ts";
import { RunnerGit } from "../runner/git.ts";

const exec = promisify(execFile);
const author = { name: "Runner test", email: "runner@example.test" };
const git = async (cwd, ...args) => (await exec(...gitCommand([
  "-c", "commit.gpgsign=false", "-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`, ...args,
]), { cwd, windowsHide: true })).stdout.trim();

test("a missing Git installation reports the required fix before an AI task", async t => {
  const root = await mkdtemp(join(tmpdir(), "runner-no-git-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const keys = ["PATH", "Path", "path", "APPDATA", "LOCALAPPDATA", "USERPROFILE", "ProgramFiles", "ProgramFiles(x86)"];
  const before = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    for (const key of keys) process.env[key] = root;
    await assert.rejects(new RunnerGit("https://workspace.example", "test-only-token", root).checkAvailable(), error => {
      assert.match(error.message, /Git was not found.*Install Git.*restart the runner/);
      assert.ok(!error.message.includes("test-only-token"));
      return true;
    });
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

// Real child processes and Git; provider fixtures avoid paid AI calls. Native
// Windows CI exercises npm .cmd resolution, pipes, and long repository files.
for (const provider of ["claude", "codex", "gemini"]) {
  test(`${provider}: workspace -> streamed reply -> checkpoint -> pushed commit -> next turn`, { timeout: 30_000 }, async t => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "runner execution ")));
    t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
    const seed = join(root, "seed");
    await mkdir(seed);
    await git(seed, "init", "-b", "main");
    await writeFile(join(seed, "code.txt"), "before\n");
    const longFile = join("source-" + "x".repeat(120), "nested-" + "y".repeat(100), "code.txt");
    await mkdir(dirname(join(seed, longFile)), { recursive: true });
    await writeFile(join(seed, longFile), "long path\n");
    await git(seed, "add", "-A");
    await git(seed, "commit", "-m", "Initial");
    const baseSha = await git(seed, "rev-parse", "HEAD");
    const serverRoot = join(root, "server");
    const remote = join(serverRoot, "api", "git", "room-a");
    await mkdir(dirname(remote), { recursive: true });
    await git(root, "clone", "--bare", seed, remote);
    await git(remote, "update-ref", "refs/heads/session/room-a", baseSha);
    // Windows limits process working directories and repository roots even
    // with core.longpaths enabled; exercise long file paths inside the repo.
    const data = join(root, "runner state");
    const runner = new RunnerGit(pathToFileURL(serverRoot).href, "test-only-token", data, join(root, "workspaces"));
    const job = { userId: "alice", sessionId: "room-a", repoId: null, baseSha, turnId: randomUUID() };
    const source = join(root, "agent.cjs");
    await writeFile(source, `#!${process.execPath}
const { writeFileSync } = require("node:fs");
const send = value => process.stdout.write(JSON.stringify(value) + "\\r\\n");
const reply = text => {
  writeFileSync("code.txt", "after\\n");
  return JSON.stringify({ text, bash: process.env.CLAUDE_CODE_GIT_BASH_PATH, nested: process.env.CLAUDECODE });
};
if (process.argv.includes("-p") && !process.argv.includes("--input-format")) {
  process.stdout.write(reply(process.argv[process.argv.indexOf("-p") + 1]));
} else require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
  const q = JSON.parse(line);
  if (q.type === "user") {
    send({ type: "stream_event", event: { type: "content_block_delta", index: 0,
      delta: { type: "text_delta", text: reply(q.message.content[0].text) } } });
    send({ type: "result", subtype: "success" });
  } else if (q.method === "initialize") send({ id: q.id, result: {} });
  else if (q.method === "thread/start") {
    if (q.params.sandbox !== "workspace-write") process.exit(9);
    send({ id: q.id, result: { thread: { id: "thread" } } });
  } else if (q.method === "turn/start") {
    if (q.params.sandboxPolicy.type !== "workspaceWrite") process.exit(9);
    send({ id: q.id, result: { turn: { id: "turn" } } });
    send({ method: "item/agentMessage/delta", params: { delta: reply(q.params.input[0].text) } });
    send({ method: "turn/completed", params: { turn: { id: "turn", status: "completed" } } });
  }
});
process.stdin.on("end", () => process.exit(0));
`, { mode: 0o755 });
    let bin = source;
    if (process.platform === "win32") {
      bin = join(root, `${provider}.cmd`);
      await writeFile(bin, '@echo off\r\nnode "%~dp0\\agent.cjs" %*\r\n');
    }
    const settings = { CLAUDE_CODE_GIT_BASH_PATH: "D:\\Developer Tools\\Git\\bin\\bash.exe", CLAUDECODE: "1", ANTHROPIC_API_KEY: undefined, GEMINI_API_KEY: undefined, GOOGLE_API_KEY: undefined };
    const before = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]));
    for (const [key, value] of Object.entries(settings)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    t.after(() => {
      for (const [key, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    });
    const prompt = 'Fix this & echo INJECTED | more %PATH% "quotes"\r\n' + "context ".repeat(provider === "gemini" ? 1000 : 10_000);
    let work;
    const sha = await runner.withWorkspace(job, async workspace => {
      work = workspace.path;
      const cache = await git(work, "rev-parse", "--path-format=absolute", "--git-common-dir");
      assert.ok(join(work, longFile).length > 260, "exercise files beyond the Windows default limit");
      assert.equal(await readFile(join(work, longFile), "utf8"), "long path\n");
      if (process.platform === "win32") {
        assert.ok(cache.length < 260, "the repository root must fit Windows' directory limit");
        assert.ok(`${cache}.${randomUUID()}.tmp`.length > 260, "a temp suffix on the cache would exceed the directory limit");
        assert.equal(await git(work, "config", "--local", "core.longpaths"), "true");
      }
      await workspace.checkpoint();
      const events = [];
      const input = { spec: { ...agentById(provider), bin }, cwd: work, prompt, onEvent: event => events.push(event),
        inputs: { claim: async () => null, subscribe: () => () => {} } };
      const result = await (provider === "codex" ? runCodexSession(input) : runAgentLocally(input));
      assert.equal(result.code, 0, result.errOutput);
      assert.deepEqual(JSON.parse(result.output), { text: prompt, bash: settings.CLAUDE_CODE_GIT_BASH_PATH });
      assert.ok(events.some(event => event.t === "out"));
      assert.equal(await readFile(join(work, "code.txt"), "utf8"), "after\n");
      await workspace.checkpoint();
      return workspace.commitAndPush("AI change", author);
    });
    assert.equal(await git(remote, "rev-parse", `refs/turns/${job.turnId}`), sha);
    const snapshots = [];
    await runner.deliverCheckpoints({ checkpoint: async snapshot => snapshots.push(snapshot) });
    assert.equal(snapshots.length, 2);
    await git(remote, "update-ref", "refs/heads/session/room-a", sha);
    await runner.withWorkspace({ ...job, baseSha: sha, turnId: randomUUID() }, async workspace => {
      assert.equal(workspace.path, work);
      assert.equal(await workspace.commitAndPush("Unchanged", author), null);
    });
  });
}

// Stop in the chat aborts the run: the agent and every command it started end,
// and what it wrote and changed so far is still there to keep.
test("stopping a run ends the agent and the commands it started, and keeps its partial work", { timeout: 30_000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "runner stop ")));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const pidFile = join(root, "grandchild.pid");
  const source = join(root, "agent.cjs");
  await writeFile(source, `#!${process.execPath}
const { writeFileSync } = require("node:fs");
const { spawn } = require("node:child_process");
const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
  if (JSON.parse(line).type !== "user") return;
  writeFileSync("code.txt", "partial\\n");
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
  send({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Working on it" } } });
  setInterval(() => {}, 1000);
});
`, { mode: 0o755 });
  let bin = source;
  if (process.platform === "win32") {
    bin = join(root, "claude.cmd");
    await writeFile(bin, '@echo off\r\nnode "%~dp0\\agent.cjs" %*\r\n');
  }
  const stop = new AbortController();
  const events = [];
  const started = Date.now();
  const running = runAgentLocally({ spec: { ...agentById("claude"), bin }, cwd: root, prompt: "Do the long task", signal: stop.signal,
    onEvent: event => { events.push(event); if (event.t === "out") stop.abort(); } });
  const result = await running;
  assert.ok(Date.now() - started < 20_000, "stops promptly");
  assert.notEqual(result.code, 0);
  assert.match(result.output, /Working on it/);
  assert.equal(await readFile(join(root, "code.txt"), "utf8"), "partial\n");
  const pid = Number(await readFile(pidFile, "utf8"));
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (let waited = 0; alive() && waited < 10_000; waited += 200) await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(alive(), false, "the command the agent started ended too");
});
