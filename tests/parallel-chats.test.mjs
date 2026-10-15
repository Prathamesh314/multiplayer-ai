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
import { chatBranchState, chatFileDiff, mergeChatIntoRoom, updateChatFromRoom, setChatDiscarded } from "../app/lib/ai/chat-branch.ts";
import { listRunMessages } from "../app/lib/ai/runs.ts";
import { moveBranch, repoContainsCommit, sessionBranchOf } from "../app/lib/session/repo.ts";

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
const roomHead = async (room = roomId) => (await sql(`SELECT head_sha FROM session_repos WHERE session_id = $1`, [room])).rows[0].head_sha;
const branchTip = async (runId, room = roomId) => (await objectText(barePath(room), ["rev-parse", `refs/heads/${chatBranchOf(runId)}`])).trim();
const gitRoomTip = async room => (await objectText(barePath(room), ["rev-parse", `refs/heads/${sessionBranchOf(room)}`])).trim();

/** Reserve, prepare and start one server-executed turn, then write `text` to `file` and commit it. */
async function runTurn(run, userId, { file, text, baseSha, version = 0, room = roomId }) {
  const job = {
    turnId: randomUUID(), userId, controlVersion: version, sessionId: room, runId: run.id, repoId: null,
    baseSha, agentId: "codex", agentPrompt: "Change the file", userPrompt: "Change the file", author,
    ...(run.isolation === "isolated" ? { isolation: "isolated", chatBranch: chatBranchOf(run.id) } : {}),
  };
  await reserveTurn(run.id, userId, job.turnId, version);
  await prepareTurn(job);
  assert.equal(await startTurn(job), true);
  const work = await prepareTurnWork(room, job.turnId, baseSha);
  await writeFile(join(work, file), text);
  const sha = await commitTurnWork(room, job.turnId, baseSha, author);
  return { job, sha };
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

  // --- Review and integration: merge, update, discard ----------------------
  const mergeRoom = "mergeroomabc";
  const viewer = await user("viewer");
  await sql(`INSERT INTO sessions(id, name, join_code, owner_id) VALUES ($1, 'Merge test', 'MERG-ERRM', $2)`, [mergeRoom, alice]);
  for (const [userId, role] of [[alice, "owner"], [bob, "editor"], [viewer, "viewer"]]) {
    await sql(`INSERT INTO session_members(session_id,user_id,role,added_via) VALUES ($1,$2,$3,'owner')`, [mergeRoom, userId, role]);
  }
  await createRepo(mergeRoom);
  await writeSeedBatch(mergeRoom, ["a", "b", "c", "d"].map(name => ({ path: `${name}.txt`, data: Buffer.from(`${name}\n`).toString("base64") })));
  const mergeSeed = await finishSeed(mergeRoom, "merge fixture");
  await attachRepo(mergeRoom, mergeSeed, null);
  const start = mergeSeed.headSha;
  const actor = (id, name) => ({ id, name, email: `${name.toLowerCase()}@example.test` });
  const aliceActor = actor(alice, "Alice"), bobActor = actor(bob, "Bob"), viewerActor = actor(viewer, "Viewer");
  /** Open an isolated chat at the room head and give it one finished turn writing `text` to `file`. */
  const chatWith = async (file, text, base = start) => {
    const run = await createRun({ sessionId: mergeRoom, startedBy: alice, agentId: "codex", baseSha: base, isolation: "isolated" });
    const turn = await runTurn(run, alice, { file, text, baseSha: base, room: mergeRoom });
    assert.equal((await finish(turn.job, turn.sha)).status, "completed");
    return { run, sha: turn.sha };
  };
  const merge = (run, by = aliceActor, heads = {}) => chatBranchState(run.id, mergeRoom, by.id).then(state =>
    mergeChatIntoRoom({ runId: run.id, sessionId: mergeRoom, actor: by, expectedChatHead: state.chatHead, expectedRoomHead: state.roomHead, ...heads }));
  const update = (run, by = aliceActor, extra = {}) => chatBranchState(run.id, mergeRoom, by.id).then(state =>
    updateChatFromRoom({ runId: run.id, sessionId: mergeRoom, actor: by, version: 0, expectedChatHead: state.chatHead, expectedRoomHead: state.roomHead, ...extra }));

  const first = await chatWith("a.txt", "first chat\n");
  const second = await chatWith("b.txt", "second chat\n");
  const stale = await chatWith("c.txt", "stale chat\n");
  const clashing = await chatWith("a.txt", "clashing chat\n");

  await test("a chat's state lists its proposal against the room, with per-file diffs", async () => {
    const state = await chatBranchState(first.run.id, mergeRoom, viewer);
    assert.deepEqual([state.ahead, state.behind, state.base, state.roomHead, state.mergeState], [1, 0, start, start, "open"]);
    assert.deepEqual([state.running, state.driverUserId, state.controlVersion], [false, alice, 0]);
    assert.deepEqual(state.files, [{ path: "a.txt", status: "M", added: 1, removed: 1 }]);
    assert.deepEqual(state.conflictMarkers, []);
    assert.match(await chatFileDiff(first.run.id, mergeRoom, viewer, "a.txt"), /^\+first chat$/m);
    await assert.rejects(chatBranchState(randomUUID(), mergeRoom, alice), /not found/);
  });

  await test("viewers can review but not merge", async () => {
    await assert.rejects(merge(first.run, viewerActor), error => error.status === 403);
    assert.equal(await roomHead(mergeRoom), start);
  });

  await test("the first chat merges by fast-forwarding the room branch", async () => {
    const outcome = await merge(first.run, bobActor);
    assert.deepEqual(outcome, { ok: true, sha: first.sha, changed: true });
    assert.equal(await roomHead(mergeRoom), first.sha);
    assert.equal(await gitRoomTip(mergeRoom), first.sha);
    const run = await getRun(first.run.id);
    assert.equal(run.mergeState, "merged");
    assert.equal(run.mergedSha, first.sha);
    assert.match((await listRunMessages(first.run.id)).at(-1).body, /Bob merged this chat into the room/);
    assert.deepEqual((await chatBranchState(first.run.id, mergeRoom, alice)).files, []);
  });

  await test("a second chat from the same base merges with a real merge commit", async () => {
    const outcome = await merge(second.run);
    assert.equal(outcome.ok, true);
    const parents = (await objectText(barePath(mergeRoom), ["show", "-s", "--format=%P", outcome.sha])).trim().split(" ");
    assert.deepEqual(parents, [first.sha, second.sha]);
    for (const [file, text] of [["a.txt", "first chat\n"], ["b.txt", "second chat\n"]]) {
      assert.equal((await readCommittedBytes(mergeRoom, outcome.sha, file)).toString(), text);
    }
    // Shared memory publishes a turn once its commit is an ancestor of the published branch.
    assert.equal(await repoContainsCommit(mergeRoom, second.sha, outcome.sha), true);
  });

  await test("a merge against heads the reviewer no longer sees is refused", async () => {
    await assert.rejects(merge(stale.run, aliceActor, { expectedRoomHead: start }), /changed/);
    const head = await roomHead(mergeRoom);
    assert.equal(await gitRoomTip(mergeRoom), head);
  });

  await test("conflicting changes are reported and nothing moves", async () => {
    const before = await roomHead(mergeRoom);
    const outcome = await merge(clashing.run);
    assert.deepEqual(outcome, { ok: false, reason: "conflict", files: ["a.txt"] });
    assert.equal(await roomHead(mergeRoom), before);
    assert.equal(await gitRoomTip(mergeRoom), before);
    assert.equal(await branchTip(clashing.run.id, mergeRoom), clashing.sha);
    assert.equal((await getRun(clashing.run.id)).mergeState, "open");
  });

  await test("only the chat's driver updates it from the room", async () => {
    await assert.rejects(update(clashing.run, bobActor), /driver/);
    assert.deepEqual(await update(clashing.run), { ok: false, reason: "conflict", files: ["a.txt"] });
    assert.equal(await branchTip(clashing.run.id, mergeRoom), clashing.sha);
  });

  let resolvedBase;
  await test("an update can commit conflict markers to the chat's own branch, and merging waits for them", async () => {
    const room = await roomHead(mergeRoom);
    const outcome = await update(clashing.run, aliceActor, { allowConflicts: true });
    assert.equal(outcome.ok, true);
    assert.deepEqual(outcome.conflicts, ["a.txt"]);
    assert.deepEqual((await objectText(barePath(mergeRoom), ["show", "-s", "--format=%P", outcome.sha])).trim().split(" "), [clashing.sha, room]);
    assert.match((await readCommittedBytes(mergeRoom, outcome.sha, "a.txt")).toString(), /^<{7} /m);
    assert.equal(await roomHead(mergeRoom), room, "the room never sees conflict markers");
    const state = await chatBranchState(clashing.run.id, mergeRoom, alice);
    assert.deepEqual([state.behind, state.conflictMarkers], [0, ["a.txt"]]);
    assert.deepEqual(await merge(clashing.run), { ok: false, reason: "markers", files: ["a.txt"] });
    assert.match((await listRunMessages(clashing.run.id)).at(-1).body, /conflict markers to resolve before merging:\n· a\.txt/);
    resolvedBase = outcome.sha;
  });

  await test("once the agent resolves the markers, the chat merges cleanly", async () => {
    const fix = await runTurn(clashing.run, alice, { file: "a.txt", text: "first chat\nclashing chat\n", baseSha: resolvedBase, room: mergeRoom });
    assert.equal((await finish(fix.job, fix.sha)).status, "completed");
    const outcome = await merge(clashing.run);
    assert.deepEqual(outcome, { ok: true, sha: fix.sha, changed: true });
    assert.equal((await readCommittedBytes(mergeRoom, await roomHead(mergeRoom), "a.txt")).toString(), "first chat\nclashing chat\n");
  });

  await test("a chat with nothing new is updated by fast-forwarding to the room", async () => {
    const idle = await createRun({ sessionId: mergeRoom, startedBy: alice, agentId: "codex", baseSha: start, isolation: "isolated" });
    const outcome = await update(idle);
    assert.deepEqual(outcome, { ok: true, sha: await roomHead(mergeRoom), changed: true, conflicts: [] });
    assert.equal((await getRun(idle.id)).headSha, outcome.sha);
  });

  await test("discarding needs the driver or room owner, blocks merging and new turns, and can be undone", async () => {
    await assert.rejects(setChatDiscarded({ runId: stale.run.id, sessionId: mergeRoom, actor: bobActor, discarded: true }), error => error.status === 403);
    assert.deepEqual(await setChatDiscarded({ runId: stale.run.id, sessionId: mergeRoom, actor: aliceActor, discarded: true }), { mergeState: "discarded" });
    await assert.rejects(merge(stale.run), /discarded/);
    await assert.rejects(setChatDiscarded({ runId: first.run.id, sessionId: mergeRoom, actor: aliceActor, discarded: true }), /already merged/);
    assert.deepEqual(await setChatDiscarded({ runId: stale.run.id, sessionId: mergeRoom, actor: aliceActor, discarded: false }), { mergeState: "open" });
    assert.equal((await merge(stale.run)).ok, true);
  });

  await test("new work after a merge reopens the chat's proposal", async () => {
    const next = await runTurn(first.run, alice, { file: "d.txt", text: "more\n", baseSha: first.sha, room: mergeRoom });
    assert.equal((await finish(next.job, next.sha)).status, "completed");
    assert.equal((await getRun(first.run.id)).mergeState, "open");
  });

  await test("a merge whose Git step landed but whose record did not is finished on retry, and foreign moves are refused", async () => {
    const chat = await chatWith("d.txt", "interrupted\n", await roomHead(mergeRoom));
    const room = await roomHead(mergeRoom);
    // Simulate the crash window: the branch moved, the transaction never committed.
    await moveBranch(mergeRoom, sessionBranchOf(mergeRoom), chat.sha, room);
    assert.deepEqual(await mergeChatIntoRoom({ runId: chat.run.id, sessionId: mergeRoom, actor: aliceActor, expectedChatHead: chat.sha, expectedRoomHead: room }),
      { ok: true, sha: chat.sha, changed: true });
    assert.equal(await roomHead(mergeRoom), chat.sha);

    const other = await chatWith("b.txt", "other\n", chat.sha);
    // Someone else's commit on the room branch, which this merge did not produce.
    const foreign = (await objectText(barePath(mergeRoom), ["commit-tree", `${chat.sha}^{tree}`, "-p", chat.sha, "-m", "Someone else's commit"])).trim();
    await moveBranch(mergeRoom, sessionBranchOf(mergeRoom), foreign, chat.sha);
    await assert.rejects(mergeChatIntoRoom({ runId: other.run.id, sessionId: mergeRoom, actor: aliceActor, expectedChatHead: other.sha, expectedRoomHead: chat.sha }), /outside this merge/);
    assert.equal(await gitRoomTip(mergeRoom), foreign);
    assert.equal((await getRun(other.run.id)).mergeState, "open");
    await moveBranch(mergeRoom, sessionBranchOf(mergeRoom), chat.sha, foreign);
  });

  console.log(`\n${passed} parallel chat checks passed.`);
} finally {
  await embedded.close();
  delete globalThis.__maPool;
  await rm(directory, { recursive: true, force: true });
}
