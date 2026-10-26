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

// Long tasks: a turn runs as long as the agent keeps working, and is stopped
// only when it goes quiet (or past the overall cap), never on a fixed clock.
test("a busy agent runs past the quiet limit; a silent one is stopped with the reason", { timeout: 30_000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "runner long ")));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const previous = process.env.RUNNER_IDLE_MINUTES;
  process.env.RUNNER_IDLE_MINUTES = String(1.5 / 60); // 1.5 seconds
  t.after(() => { if (previous === undefined) delete process.env.RUNNER_IDLE_MINUTES; else process.env.RUNNER_IDLE_MINUTES = previous; });
  const agent = async (name, body) => {
    const source = join(root, `${name}.cjs`);
    await writeFile(source, `#!${process.execPath}
const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
const say = text => send({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } });
require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
  if (JSON.parse(line).type !== "user") return;
  ${body}
});
`, { mode: 0o755 });
    if (process.platform !== "win32") return source;
    const shim = join(root, `${name}.cmd`);
    await writeFile(shim, `@echo off\r\nnode "%~dp0\\${name}.cjs" %*\r\n`);
    return shim;
  };
  // Working for 4 s (past the 1.5 s quiet limit) but never quiet for long: it finishes.
  const busy = await agent("busy", `let n = 0; const timer = setInterval(() => { say("step " + (++n) + "\\n"); if (n === 16) { clearInterval(timer); send({ type: "result", subtype: "success" }); process.exit(0); } }, 250);`);
  const started = Date.now();
  const done = await runAgentLocally({ spec: { ...agentById("claude"), bin: busy }, cwd: root, prompt: "Long task", onEvent: () => {} });
  assert.equal(done.code, 0, done.errOutput);
  assert.ok(Date.now() - started >= 3500, "it ran past the quiet limit");
  assert.match(done.output, /step 16/);
  // Says one thing, then nothing: stopped once quiet, with why.
  const silent = await agent("silent", `say("Starting"); setInterval(() => {}, 1000);`);
  const events = [];
  const stopped = await runAgentLocally({ spec: { ...agentById("claude"), bin: silent }, cwd: root, prompt: "Hang", onEvent: event => events.push(event) });
  assert.notEqual(stopped.code, 0);
  assert.ok(events.some(event => event.t === "notice" && /produced no output for/.test(event.message)), "says it stopped because the agent went quiet");
});

test("run limits: quiet time and the overall cap, both paused while a person decides; long replies keep their end", async () => {
  const { RunWatch, keepTail } = await import("../runner/permissions.ts");
  const expired = [];
  const watch = new RunWatch({ idleMs: 300, maxMs: 60_000 }, reason => expired.push(reason));
  await new Promise(resolve => setTimeout(resolve, 200)); watch.activity();
  await new Promise(resolve => setTimeout(resolve, 200)); watch.activity();
  assert.deepEqual(expired, [], "activity keeps it going");
  await watch.hold(() => new Promise(resolve => setTimeout(resolve, 700)));
  assert.deepEqual(expired, [], "waiting for a person does not count");
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.deepEqual(expired, ["idle"]);
  const capped = [];
  const total = new RunWatch({ idleMs: 60_000, maxMs: 200 }, reason => capped.push(reason));
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.deepEqual(capped, ["time"]);
  total.clear();
  assert.equal(keepTail("abcdef", 10), "abcdef");
  assert.equal(keepTail("x".repeat(20) + "THE ANSWER", 10), "[…earlier output trimmed…]\nTHE ANSWER");
});

test("the computer is kept awake while a task runs, and released after", async () => {
  const { keepAwake, awakeHolds } = await import("../runner/keep-awake.ts");
  const first = keepAwake(), second = keepAwake();
  assert.equal(awakeHolds(), 2, "parallel tasks share one hold");
  first(); first();
  assert.equal(awakeHolds(), 1, "releasing twice counts once");
  second();
  assert.equal(awakeHolds(), 0);
});

// A chat's next turn resumes the tool's own session, so the agent remembers
// earlier turns; a session this computer does not have starts a new one with
// the conversation so far in the prompt.
test("each chat resumes its own session with the tool, and starts a new one when it cannot", { timeout: 30_000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "runner sessions ")));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const known = join(root, "known-sessions.txt");
  await writeFile(known, "");
  const source = join(root, "agent.cjs");
  // A Claude-like tool: --session-id starts a session, --resume needs one it knows.
  await writeFile(source, `#!${process.execPath}
const { appendFileSync, readFileSync } = require("node:fs");
const args = process.argv.slice(2);
const known = ${JSON.stringify(known)};
const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
const at = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : null;
const resume = at("--resume"), start = at("--session-id");
if (resume && !readFileSync(known, "utf8").split("\\n").includes(resume)) { console.error("No conversation found with session ID: " + resume); process.exit(1); }
if (start) appendFileSync(known, start + "\\n");
require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
  const q = JSON.parse(line);
  if (q.type !== "user") return;
  send({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: JSON.stringify({ resume, start, prompt: q.message.content[0].text }) } } });
  send({ type: "result", subtype: "success" });
  process.exit(0);
});
`, { mode: 0o755 });
  let bin = source;
  if (process.platform === "win32") { bin = join(root, "claude.cmd"); await writeFile(bin, '@echo off\r\nnode "%~dp0\\agent.cjs" %*\r\n'); }
  const { ChatSessions } = await import("../runner/chat-sessions.ts");
  const sessions = new ChatSessions(join(root, "chat-sessions.json"));
  const runId = randomUUID();
  const turn = async (prompt, resumePrompt) => {
    const previous = await sessions.get(runId, "claude", root);
    const events = [];
    const result = await runAgentLocally({ spec: { ...agentById("claude"), bin }, cwd: root, prompt, onEvent: event => events.push(event),
      session: { previous, resumePrompt, save: id => void sessions.set(runId, { agentId: "claude", sessionId: id, cwd: root }) } });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(result.code, 0, result.errOutput);
    return { said: JSON.parse(result.output), notices: events.filter(event => event.t === "notice").map(event => event.message) };
  };
  // First turn: a new session, with an id chosen by the runner.
  const first = await turn("Full prompt 1");
  assert.match(first.said.start, /^[0-9a-f-]{36}$/);
  assert.equal(first.said.prompt, "Full prompt 1");
  // Next turn: the same session, resumed with the shorter prompt.
  const second = await turn("Full prompt 2 with the conversation so far", "Just the new message");
  assert.equal(second.said.resume, first.said.start);
  assert.equal(second.said.prompt, "Just the new message");
  // A session this computer does not have (another computer's, or deleted): a new one, with everything.
  await writeFile(known, "");
  const third = await turn("Full prompt 3 with the conversation so far", "Just the newest message");
  assert.equal(third.said.resume, null);
  assert.equal(third.said.prompt, "Full prompt 3 with the conversation so far");
  assert.ok(third.notices.some(message => /Started a new session/.test(message)));
  assert.equal(await sessions.get(runId, "claude", root), third.said.start, "the new session is the chat's from now on");
  // Sessions belong to a chat, its tool and its folder.
  assert.equal(await sessions.get(runId, "codex", root), null);
  assert.equal(await sessions.get(runId, "claude", join(root, "elsewhere")), null);
  assert.equal(await sessions.get(randomUUID(), "claude", root), null);
});

test("tools that take the prompt on stdin get a much larger context budget", async () => {
  const { promptBudget, maxUserPrompt, MAX_PROMPT, MAX_SESSION_PROMPT } = await import("../app/lib/ai/prompt.ts");
  assert.equal(promptBudget("claude"), MAX_SESSION_PROMPT);
  assert.equal(promptBudget("codex"), MAX_SESSION_PROMPT);
  assert.equal(promptBudget("gemini"), MAX_PROMPT, "Gemini takes its prompt on the command line");
  assert.ok(maxUserPrompt("claude") >= 200_000);
  assert.equal(maxUserPrompt("gemini"), MAX_PROMPT - 8000);
});
