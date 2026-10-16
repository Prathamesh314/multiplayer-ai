// The server relay between a member's browser and the terminal host on their
// own computer, wired through the real event bus (in memory) and a real
// TerminalHost: device choice, keystrokes in, output out, and isolation.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryFixture } from "./helpers/memory-fixture.mjs";
import { createRun } from "../app/lib/ai/runs.ts";
import { events } from "../app/lib/events/index.ts";
import { controlRemote, isRemote, openRemote, pickTerminalDevice, relayFromRunner } from "../app/lib/terminal/remote.ts";
import { TerminalHost } from "../runner/terminal.ts";

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(check, label, ms = 15_000) {
  for (const start = Date.now(); Date.now() - start < ms; await delay(50)) if (await check()) return;
  throw new Error(`Timed out: ${label}`);
}

const f = await memoryFixture();
const directory = await realpath(await mkdtemp(join(tmpdir(), "terminal-relay-")));
let host;
try {
  const device = async (userId, name, { terminal = true, seen = "now()" } = {}) => (await f.first(
    `INSERT INTO runner_devices(user_id,name,token_hash,version,supports_terminal,last_seen_at) VALUES ($1,$2,$3,'2',$4,${seen}) RETURNING id, name`,
    [userId, name, Buffer.from(randomUUID()), terminal]));
  const older = await device(f.alice, "Alice's laptop", { seen: "now() - interval '5 seconds'" });
  const newest = await device(f.alice, "Alice's desktop");
  await device(f.alice, "No terminals", { terminal: false });
  await device(f.alice, "Offline", { seen: "now() - interval '10 minutes'" });
  await device(f.bob, "Bob's Mac");

  // Device choice: the computer that ran the chat, else the most recently seen; only terminal hosts, online, owned.
  assert.deepEqual(await pickTerminalDevice(f.alice, null), newest, "most recently seen computer that hosts terminals");
  const run = await createRun({ sessionId: f.room, startedBy: f.alice, agentId: "codex", baseSha: "a".repeat(40) });
  await f.db.query("UPDATE agent_runs SET assigned_device_id=$2 WHERE id=$1", [run.id, older.id]);
  assert.deepEqual(await pickTerminalDevice(f.alice, run.id), older, "the computer holding the chat's worktree");
  assert.equal((await pickTerminalDevice(f.outsider, null)), null, "no computer, no terminal");

  // Alice's chosen computer: a real terminal host listening on its device channel.
  const bus = await events();
  host = new TerminalHost(report => relayFromRunner(f.alice, "output" in report
    ? { type: "terminal.output", id: report.id, data: report.output, at: Date.now() }
    : "exit" in report ? { type: "terminal.exit", id: report.id, code: report.exit, at: Date.now() }
    : { type: "terminal.notice", id: report.id, message: report.notice, at: Date.now() }),
  async () => ({ path: directory, label: "room worktree" }), { shell: "/bin/sh" });
  const opened = [];
  await bus.subscribe(`device:${older.id}`, event => { if (event.type === "terminal.open") opened.push(event); host.handle(event.type, event); });

  const received = [];
  const id = randomUUID();
  const text = () => Buffer.concat(received.filter(event => event.type === "terminal.output").map(event => Buffer.from(event.data, "base64"))).toString();
  const detach = await openRemote({ id, userId: f.alice, device: older, cols: 90, rows: 25,
    context: { repoRef: f.room, runId: run.id, isolated: false }, onEvent: event => received.push(event) });
  await eventually(() => opened.length === 1, "open reaches the computer");
  assert.equal(opened[0].userId, f.alice);
  assert.equal(opened[0].runId, run.id);
  assert.equal(isRemote(id, f.alice), true);

  assert.equal(await controlRemote(id, f.alice, { type: "input", data: "echo relay-$((40+2)); pwd\r" }), true);
  await eventually(() => text().includes("relay-42") && text().includes(directory), "keystrokes in, output out");
  await controlRemote(id, f.alice, { type: "resize", cols: 132, rows: 41 });
  await delay(100);
  await controlRemote(id, f.alice, { type: "input", data: "stty size\r" });
  await eventually(() => text().includes("41 132"), "resize relayed");

  // Nobody else reaches it: Bob's controls are refused and never reach the computer.
  assert.equal(isRemote(id, f.bob), false);
  assert.equal(await controlRemote(id, f.bob, { type: "input", data: "echo intruder\r" }), false);
  await assert.rejects(openRemote({ id, userId: f.bob, device: older, cols: 80, rows: 24,
    context: { repoRef: null, runId: null, isolated: false }, onEvent: () => {} }), /someone else/);
  await delay(200);
  assert.equal(text().includes("intruder"), false);

  await controlRemote(id, f.alice, { type: "kill" });
  await eventually(() => received.some(event => event.type === "terminal.exit"), "exit reaches the browser");
  assert.equal(isRemote(id, f.alice), false, "a killed terminal is forgotten");
  await detach();
  console.log("Terminal relay: device choice, keystrokes and resizes in, output and exit out, other members refused.");
} finally {
  host?.closeAll();
  await f.close();
  await rm(directory, { recursive: true, force: true });
}
