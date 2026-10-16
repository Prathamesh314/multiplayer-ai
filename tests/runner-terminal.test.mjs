// Terminals the runner hosts for its owner: real shells in a chat's worktree.
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TerminalHost, findPtyPython, shellEnvironment } from "../runner/terminal.ts";

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(check, label, ms = 15_000) {
  for (const start = Date.now(); Date.now() - start < ms; await delay(50)) if (await check()) return;
  throw new Error(`Timed out: ${label}`);
}

/** A host whose reports are collected, opening every terminal in `directory`. */
function host(directory, options) {
  const reports = [];
  const terminals = new TerminalHost(async report => { reports.push(report); }, async () => ({ path: directory, label: "room worktree" }), options);
  const output = id => Buffer.concat(reports.filter(report => report.id === id && "output" in report).map(report => Buffer.from(report.output, "base64"))).toString("utf8");
  return { terminals, reports, output };
}
const open = (terminals, id, cols = 100, rows = 30) => terminals.handle("terminal.open", { id, userId: "alice", cols, rows, repoRef: "room-a", runId: null, isolated: false });

const python = findPtyPython();

test("a terminal is a real shell in the chat's worktree, resizable like a TTY", { skip: !python && "Python 3 with pty is not available here" }, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "runner-terminal-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { terminals, reports, output } = host(directory, { shell: "/bin/sh" });
  t.after(() => terminals.closeAll());
  open(terminals, "term-1");
  await eventually(() => reports.some(report => report.notice?.includes(directory)), "location notice");
  terminals.handle("terminal.input", { id: "term-1", data: "pwd; stty size; echo term=$TERM\r" });
  await eventually(() => output("term-1").includes("30 100") && output("term-1").includes(directory) && output("term-1").includes("term=xterm-256color"), "pwd, size and TERM");
  terminals.handle("terminal.resize", { id: "term-1", cols: 120, rows: 40 });
  await delay(100);
  terminals.handle("terminal.input", { id: "term-1", data: "stty size\r" });
  await eventually(() => output("term-1").includes("40 120"), "resized TTY");

  // A reload reattaches to the same shell and replays its recent output.
  terminals.handle("terminal.detach", { id: "term-1" });
  const before = reports.length;
  open(terminals, "term-1");
  await eventually(() => reports.slice(before).some(report => "output" in report && Buffer.from(report.output, "base64").toString().includes("40 120")), "replay on reattach");

  terminals.handle("terminal.kill", { id: "term-1" });
  await eventually(() => reports.some(report => report.id === "term-1" && "exit" in report), "exit reported");
});

test("without Python a basic shell still runs commands, and says it is basic", async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "runner-terminal-basic-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { terminals, reports, output } = host(directory, { python: null, shell: "/bin/sh" });
  t.after(() => terminals.closeAll());
  open(terminals, "term-2");
  await eventually(() => reports.some(report => report.notice?.startsWith("Basic terminal")), "basic notice");
  terminals.handle("terminal.input", { id: "term-2", data: "echo basic-$((1+2)); pwd\r" });
  await eventually(() => output("term-2").includes("basic-3") && output("term-2").includes(directory), "command output");
  terminals.handle("terminal.kill", { id: "term-2" });
  await eventually(() => reports.some(report => report.id === "term-2" && "exit" in report), "exit reported");
});

test("malformed messages are ignored and unknown terminals are untouched", () => {
  const { terminals, reports } = host(tmpdir(), { python: null, shell: "/bin/sh" });
  for (const [type, data] of [["terminal.open", { id: "../../etc" }], ["terminal.input", { id: "missing", data: "x" }], ["terminal.kill", null], ["terminal.resize", { id: 7 }]]) {
    terminals.handle(type, data);
  }
  assert.deepEqual(reports, []);
});

test("a member's shell gets a terminal environment without the runner's own variables", () => {
  const env = shellEnvironment({ PATH: "/usr/bin", HOME: "/home/alice", ELECTRON_RUN_AS_NODE: "1", GIT_DIR: "/x", RUNNER_CONFIG: "/c", TERM: "dumb" });
  assert.equal(env.TERM, "xterm-256color");
  assert.equal(env.PATH, "/usr/bin");
  for (const key of ["ELECTRON_RUN_AS_NODE", "GIT_DIR", "RUNNER_CONFIG"]) assert.equal(env[key], undefined, key);
});
