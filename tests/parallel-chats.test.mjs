// Isolated ("parallel") chats: branch-per-chat promotion, admission and
// runner routing. Runs against PGlite with real bare Git repositories.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { migrate } from "../db/migrate.mjs";
import { createRun, getRun } from "../app/lib/ai/runs.ts";
import { reserveTurn, prepareTurn, startTurn } from "../app/lib/ai/turns.ts";
import { finalizeAgentRun } from "../app/lib/ai/finalize.ts";
import { checkRunAllowed } from "../app/lib/ai/usage.ts";
import { createRepo, finishSeed, writeSeedBatch, prepareTurnWork, commitTurnWork, readCommittedBytes,
  createChatBranch, chatBranchOf, headSha } from "../app/lib/session/repo.ts";
import { attachRepo } from "../app/lib/session/store.ts";
import { barePath } from "../app/lib/session/paths.ts";
import { objectText } from "../app/lib/git/objects.ts";
import { enqueueLocalJob, claimNextJob } from "../app/lib/runner/jobs.ts";
import { candidatePush } from "../app/lib/runner/push.ts";
import { chatAccess, currentHead } from "../app/lib/collaboration/access.ts";
import { transaction } from "../app/lib/db/client.ts";

delete process.env.REDIS_URL;
delete process.env.MNEMOSYNE_URL;
const directory = await mkdtemp(join(tmpdir(), "parallel-chats-test-"));
process.env.MULTIPLAYER_AI_DATA = directory;

const embedded = await PGlite.create({ extensions: { citext, vector } });
let waiting = Promise.resolve();
async function acquire() {
  const previous = waiting;
  let release;
  waiting = new Promise(resolve => { release = resolve; });
  await previous;
  return release;
}
const execute = async (sql, params) => {
  const result = await embedded.query(sql, params);
  return { ...result, rowCount: result.affectedRows ?? result.rows.length };
};
globalThis.__maPool = {
  async query(sql, params) { const release = await acquire(); try { return await execute(sql, params); } finally { release(); } },
  async connect() { const release = await acquire(); return { query: execute, release }; },
};

let passed = 0;
async function test(name, task) {
  await task();
  passed += 1;
  console.log(`  ok ${name}`);
}
const sql = (text, params) => embedded.query(text, params);
const roomId = "parallelroom";
const author = { name: "Alice", email: "alice@example.test" };
const roomHead = async () => (await sql(`SELECT head_sha FROM session_repos WHERE session_id = $1`, [roomId])).rows[0].head_sha;
const branchTip = async runId => (await objectText(barePath(roomId), ["rev-parse", `refs/heads/${chatBranchOf(runId)}`])).trim();

/** Reserve, prepare and start one server-executed turn, then write `text` to `file` and finalize it. */
async function runTurn(run, userId, { file, text, baseSha, version = 0 }) {
  const job = {
    turnId: randomUUID(), userId, controlVersion: version, sessionId: roomId, runId: run.id, repoId: null,
    baseSha, agentId: "codex", agentPrompt: "Change the file", userPrompt: "Change the file", author,
    ...(run.isolation === "isolated" ? { isolation: "isolated", chatBranch: chatBranchOf(run.id) } : {}),
  };
  await reserveTurn(run.id, userId, job.turnId, version);
  await prepareTurn(job);
  assert.equal(await startTurn(job), true);
  const work = await prepareTurnWork(roomId, job.turnId, baseSha);
  await writeFile(join(work, file), text);
  const sha = await commitTurnWork(roomId, job.turnId, baseSha, author);
  return { job, sha, reserve: null };
}
const finish = (job, sha) => finalizeAgentRun({
  turnId: job.turnId, sessionId: job.sessionId, runId: job.runId, repoId: job.repoId,
  baseSha: job.baseSha, userPrompt: job.userPrompt, binName: job.agentId, author, sha, code: 0, output: "Done", errOutput: "",
});

try {
  await migrate(embedded);
  let userNumber = 0;
  const user = async name => {
    userNumber += 1;
    return (await sql(`INSERT INTO users(handle, email, display_name, connect_code) VALUES ($1,$2,$4,$3) RETURNING id`,
      [name, `${name}@example.test`, `PK-AAAA-AAA${"ABCDEFGH"[userNumber]}`, name])).rows[0].id;
  };
  const alice = await user("alice");
  const bob = await user("bob");
  await sql(`INSERT INTO sessions(id, name, join_code, owner_id) VALUES ($1, 'Parallel test', 'PARA-LLEL', $2)`, [roomId, alice]);
  for (const [userId, role] of [[alice, "owner"], [bob, "editor"]]) {
    await sql(`INSERT INTO session_members(session_id,user_id,role,added_via) VALUES ($1,$2,$3,'owner')`, [roomId, userId, role]);
  }
  await createRepo(roomId);
  await writeSeedBatch(roomId, [
    { path: "a.txt", data: Buffer.from("a\n").toString("base64") },
    { path: "b.txt", data: Buffer.from("b\n").toString("base64") },
  ]);
  const seed = await finishSeed(roomId, "fixture");
  await attachRepo(roomId, seed, null);
  const fork = seed.headSha;

  let left;
  let right;
  await test("an isolated chat opens on its own branch at the room head", async () => {
    left = await createRun({ sessionId: roomId, startedBy: alice, agentId: "codex", baseSha: fork, isolation: "isolated" });
    right = await createRun({ sessionId: roomId, startedBy: alice, agentId: "codex", baseSha: fork, isolation: "isolated" });
    for (const run of [left, right]) {
      assert.equal(run.isolation, "isolated");
      assert.equal(run.forkSha, fork);
      assert.equal(run.headSha, fork);
      assert.equal(run.mergeState, "open");
      assert.equal(await branchTip(run.id), fork);
    }
    const shared = await createRun({ sessionId: roomId, startedBy: alice, agentId: "codex", baseSha: fork });
    assert.equal(shared.isolation, "shared");
    assert.equal(shared.headSha, null);
  });

  await test("chat branches are created idempotently and only from room history", async () => {
    await createChatBranch(roomId, left.id, fork);
    const turnId = randomUUID();
    const work = await prepareTurnWork(roomId, turnId, fork);
    await writeFile(join(work, "a.txt"), "never promoted\n");
    const stray = await commitTurnWork(roomId, turnId, fork, author);
    await assert.rejects(createChatBranch(roomId, randomUUID(), stray), /room's history/);
    await assert.rejects(createChatBranch(roomId, left.id, "f".repeat(40)), /room's history|Invalid/);
    await assert.rejects(createChatBranch(roomId, "not-a-chat", fork), /Invalid chat ID/);
  });

  let leftSha;
  let rightSha;
  await test("one person runs two isolated chats at once, and both promote", async () => {
    const a = await runTurn(left, alice, { file: "a.txt", text: "left\n", baseSha: fork });
    const b = await runTurn(right, alice, { file: "b.txt", text: "right\n", baseSha: fork });
    assert.equal((await finish(a.job, a.sha)).status, "completed");
    assert.equal((await finish(b.job, b.sha)).status, "completed");
    leftSha = a.sha; rightSha = b.sha;
    assert.equal(await branchTip(left.id), leftSha);
    assert.equal(await branchTip(right.id), rightSha);
    assert.equal((await getRun(left.id)).headSha, leftSha);
    assert.equal((await getRun(right.id)).headSha, rightSha);
  });

  await test("isolated turns never move the room branch or its recorded head", async () => {
    assert.equal(await roomHead(), fork);
    assert.equal(await headSha(roomId), fork);
    assert.equal((await readCommittedBytes(roomId, await headSha(roomId), "a.txt")).toString(), "a\n");
  });

  await test("a chat's line totals cover its whole proposal, not only the last turn", async () => {
    const next = await runTurn(left, alice, { file: "b.txt", text: "left too\n", baseSha: leftSha });
    assert.equal((await finish(next.job, next.sha)).status, "completed");
    leftSha = next.sha;
    const run = await getRun(left.id);
    assert.equal(run.headSha, leftSha);
    assert.equal(run.addedLines, 2);
    assert.equal(run.removedLines, 2);
  });

  await test("a continuation based on the room head instead of the chat tip is refused", async () => {
    const stale = await runTurn(right, alice, { file: "a.txt", text: "stale\n", baseSha: fork });
    const result = await finish(stale.job, stale.sha);
    assert.equal(result.status, "failed");
    assert.equal(await branchTip(right.id), rightSha);
  });

  await test("shared chats keep the one-at-a-time rule and the room compare-and-swap", async () => {
    const first = await createRun({ sessionId: roomId, startedBy: bob, agentId: "codex", baseSha: fork });
    const second = await createRun({ sessionId: roomId, startedBy: bob, agentId: "codex", baseSha: fork });
    const turn = await runTurn(first, bob, { file: "a.txt", text: "shared\n", baseSha: fork });
    await assert.rejects(reserveTurn(second.id, bob, randomUUID(), 0), /execution limit/);
    // Bob's isolated chats are not blocked by his running shared chat.
    const parallel = await createRun({ sessionId: roomId, startedBy: bob, agentId: "codex", baseSha: fork, isolation: "isolated" });
    const parallelTurn = await runTurn(parallel, bob, { file: "b.txt", text: "bob parallel\n", baseSha: fork });
    assert.equal((await finish(turn.job, turn.sha)).status, "completed");
    assert.equal(await roomHead(), turn.sha);
    assert.equal((await finish(parallelTurn.job, parallelTurn.sha)).status, "completed");
    assert.equal(await roomHead(), turn.sha);
  });

  await test("the parallel cap is per person and spans every isolated chat", async () => {
    const base = await roomHead();
    const runs = [];
    for (let index = 0; index < 5; index += 1) runs.push(await createRun({ sessionId: roomId, startedBy: alice, agentId: "codex", baseSha: base, isolation: "isolated" }));
    for (const run of runs.slice(0, 4)) await reserveTurn(run.id, alice, randomUUID(), 0);
    await assert.rejects(reserveTurn(runs[4].id, alice, randomUUID(), 0), /4 parallel chat/);
    const gate = await checkRunAllowed({ orgId: null, projectId: null, sessionId: roomId, userId: alice, isNewRun: true, isolation: "isolated" });
    assert.equal(gate.ok, false);
    assert.equal(gate.limit, "parallel");
    // A shared chat in the room is still allowed: isolated chats don't hold the room slot.
    assert.equal((await checkRunAllowed({ orgId: null, projectId: null, sessionId: roomId, userId: alice, isNewRun: true })).ok, true);
    await sql(`UPDATE agent_turns SET status = 'failed' WHERE run_id = ANY($1) AND status = 'preparing'`, [runs.map(run => run.id)]);
    await sql(`UPDATE agent_runs SET status = 'failed' WHERE id = ANY($1)`, [runs.map(run => run.id)]);
  });

  await test("only runners that support isolated chats claim their turns", async () => {
    const run = await createRun({ sessionId: roomId, startedBy: alice, agentId: "codex", baseSha: await roomHead(), isolation: "isolated" });
    const job = {
      turnId: randomUUID(), userId: alice, controlVersion: 0, sessionId: roomId, runId: run.id, repoId: null,
      baseSha: run.headSha, isolation: "isolated", chatBranch: chatBranchOf(run.id),
      agentId: "codex", agentPrompt: "Change", userPrompt: "Change", author,
    };
    await reserveTurn(run.id, alice, job.turnId, 0);
    await prepareTurn(job, "local");
    await enqueueLocalJob(job, alice);
    const device = async (name, supports) => (await sql(`INSERT INTO runner_devices(user_id,name,token_hash,version,agent_ids,supports_isolated_chats)
      VALUES ($1,$2,$3,'2',ARRAY['codex'],$4) RETURNING id`, [alice, name, Buffer.from(randomUUID()), supports])).rows[0].id;
    const legacy = await device("old laptop", false);
    const current = await device("new laptop", true);
    assert.equal(await claimNextJob({ userId: alice, deviceId: legacy }), null);
    const claimed = await claimNextJob({ userId: alice, deviceId: current });
    assert.equal(claimed.job.turnId, job.turnId);
    assert.equal(claimed.job.chatBranch, chatBranchOf(run.id));
  });

  await test("reviews pin an isolated chat's own tip", async () => {
    await transaction(async tx => {
      const chat = await chatAccess(tx, left.id, alice);
      assert.equal(chat.isolation, "isolated");
      assert.equal(await currentHead(tx, chat), leftSha);
    });
  });

  await test("runners cannot push a chat branch directly", async () => {
    const turnId = randomUUID();
    const command = `${"0".repeat(40)} ${"a".repeat(40)} refs/heads/${chatBranchOf(left.id)}\0report-status\n`;
    const packet = `${(command.length + 4).toString(16).padStart(4, "0")}${command}`;
    await assert.rejects(candidatePush(Readable.from([`${packet}0000PACK`]), turnId));
  });

  console.log(`\n${passed} parallel chat checks passed.`);
} finally {
  await embedded.close();
  delete globalThis.__maPool;
  await rm(directory, { recursive: true, force: true });
}
