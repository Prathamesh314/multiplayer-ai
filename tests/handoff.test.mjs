import { enqueueChatInput, cancelChatInput, consumeChatInput, listChatInputs } from "../app/lib/ai/input-queue.ts";
import { persistActivity, activityPage } from "../app/lib/runner/activity.ts";
import { saveCheckpoint, listCheckpoints, getCheckpoint } from "../app/lib/runner/checkpoints.ts";
import { archiveStoredRepo, withStoredRepo } from "../app/lib/storage/git-cache.ts";
import { ActivityOutbox } from "../runner/activity-outbox.ts";
import { objectText } from "../app/lib/git/objects.ts";
import { stat } from "node:fs/promises";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, mkdir, symlink, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Readable } from "node:stream";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { citext } from "@electric-sql/pglite/contrib/citext";
import pg from "pg";
import { migrate } from "../db/migrate.mjs";
import { createRun, getRun, appendMessage, listRunMessages } from "../app/lib/ai/runs.ts";
import { reserveTurn, prepareTurn, failTurn } from "../app/lib/ai/turns.ts";
import { claimTurn, commitOnComputer } from "./helpers/runner-turn.mjs";
import { changeHandoff, handoffState, continuationContext } from "../app/lib/ai/handoff.ts";
import { finalizeAgentRun } from "../app/lib/ai/finalize.ts";
import { assembleAgentPrompt } from "../app/lib/ai/prompt.ts";
import { createRepo, finishSeed, writeSeedBatch, readCommittedBytes,
  listCommittedTree, mergeSave, promoteTurn, committedChanges, headSha } from "../app/lib/session/repo.ts";
import { barePath, workPath } from "../app/lib/session/paths.ts";
import { RunnerGit } from "../runner/git.ts";
import { attachRepo } from "../app/lib/session/store.ts";
import { createRoomRepo, finishRoomRepoSeed } from "../app/lib/session/roomRepos.ts";
import { repositoryContext } from "../app/lib/session/repository-context.ts";
import { enqueueLocalJob, claimNextJob, claimedJob, renewLease } from "../app/lib/runner/jobs.ts";
import { candidatePush } from "../app/lib/runner/push.ts";
import { createSaver } from "../app/lib/session/remote.ts";
import { storeCompletion, deliverCompletions } from "../runner/outbox.ts";

const testRedisUrl = process.env.REDIS_URL;
delete process.env.REDIS_URL;
delete process.env.MNEMOSYNE_URL;
const directory = await mkdtemp(join(tmpdir(), "handoff-test-"));
process.env.MULTIPLAYER_AI_DATA = directory;
let database;
let cleanup;
let scopedDatabaseUrl;
const realPostgres = process.env.HANDOFF_TEST_POSTGRES === "1";
if (realPostgres) {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for real PostgreSQL tests.");
  const schema = `handoff_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const scoped = new pg.Pool({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${schema},public` });
  const scopedUrl = new URL(process.env.DATABASE_URL);
  scopedUrl.searchParams.set("options", `-c search_path=${schema},public`);
  scopedDatabaseUrl = scopedUrl.toString();
  globalThis.__maPool = scoped;
  database = { query: (sql, params) => scoped.query(sql, params), exec: sql => scoped.query(sql) };
  cleanup = async () => { await scoped.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); };
} else {
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
  database = embedded;
  cleanup = () => embedded.close();
}

let passed = 0;
async function test(name, task) {
  await task();
  passed += 1;
  console.log(`  ok ${name}`);
}
const sql = (text, params) => database.query(text, params);
const roomId = "handhandoffs";
const author = { name: "Alice", email: "alice@example.test" };
let seed;
let run;
let alice;
let bob;
let carol;
let viewer;
const makeJob = (turnId, userId, version, baseSha = seed.headSha) => ({
  turnId, userId, controlVersion: version, sessionId: roomId, runId: run.id, repoId: null,
  baseSha, agentId: "codex", agentPrompt: "Make the requested change", userPrompt: "Make the requested change", author,
});
const complete = (job, sha = null, output = "Done") => finalizeAgentRun({
  turnId: job.turnId, sessionId: job.sessionId, runId: job.runId, repoId: job.repoId,
  baseSha: job.baseSha, userPrompt: job.userPrompt, binName: job.agentId, author, sha, code: 0, output, errOutput: "",
});

try {
  await migrate(database);
  let userNumber = 0;
  const user = async name => {
    userNumber += 1;
    return (await sql(`INSERT INTO users(handle, email, display_name, connect_code) VALUES ($1,$2,$4,$3) RETURNING id`,
      [name, `${name}@example.test`, `PK-AAAA-AAA${"ABCDEFGH"[userNumber]}`, name])).rows[0].id;
  };
  alice = await user("alice"); bob = await user("bob"); carol = await user("carol"); viewer = await user("viewer");
  await sql(`INSERT INTO sessions(id, name, join_code, owner_id) VALUES ($1, 'Handoff test', 'ABCD-EFGH', $2)`, [roomId, alice]);
  for (const [userId, role] of [[alice, "owner"], [bob, "editor"], [carol, "editor"], [viewer, "viewer"]]) {
    await sql(`INSERT INTO session_members(session_id,user_id,role,added_via) VALUES ($1,$2,$3,'owner')`, [roomId, userId, role]);
  }
  await createRepo(roomId);
  await writeSeedBatch(roomId, [{ path: "shared.txt", data: Buffer.from("initial\n").toString("base64") }]);
  seed = await finishSeed(roomId, "fixture");
  await attachRepo(roomId, seed, null);
  run = await createRun({ sessionId: roomId, startedBy: alice, agentId: "codex", baseSha: seed.headSha });
  const first = makeJob(randomUUID(), alice, 0);

  await test("only the driver reserves a turn; duplicate and overlapping turns are refused", async () => {
    await assert.rejects(reserveTurn(run.id, bob, randomUUID(), 0));
    await reserveTurn(run.id, alice, first.turnId, 0);
    await assert.rejects(reserveTurn(run.id, alice, randomUUID(), 0));
    await prepareTurn(first);
    // The turn runs on the member's computer: one device claims it, once.
    const { deviceId } = await claimTurn(sql, first);
    assert.equal(await claimNextJob({ userId: alice, deviceId }), null);
  });
  await test("chat inputs are durable, FIFO, driver-fenced, idempotent and sealed atomically", async () => {
    const input = { id: randomUUID(), body: "Add keyboard navigation", controlVersion: 0 };
    await assert.rejects(enqueueChatInput(run.id, bob, input), /driver/);
    await assert.rejects(enqueueChatInput(run.id, viewer, input), /access/);
    await assert.rejects(enqueueChatInput(run.id, alice, { ...input, controlVersion: 1 }), /driver/);
    await Promise.all([enqueueChatInput(run.id, alice, input), enqueueChatInput(run.id, alice, input)]);
    assert.equal((await listChatInputs(run.id)).length, 1);
    await assert.rejects(enqueueChatInput(run.id, alice, { ...input, body: "conflicting retry" }), /already/);
    const secondInput = { ...input, id: randomUUID(), body: "Also test it" };
    await enqueueChatInput(run.id, alice, secondInput);
    const cancelled = { ...input, id: randomUUID(), body: "Remove this instruction" };
    await enqueueChatInput(run.id, alice, cancelled);
    await cancelChatInput(run.id, alice, cancelled.id);
    const claimId = randomUUID();
    const claimed = await consumeChatInput(first, { kind: "claim", claimId });
    assert.equal(claimed.id, input.id);
    assert.deepEqual(await consumeChatInput(first, { kind: "claim", claimId }), claimed);
    await assert.rejects(consumeChatInput(first, { kind: "claim", claimId: randomUUID() }), /acknowledgement/);
    await assert.rejects(cancelChatInput(run.id, alice, input.id), /claimed/);
    const before = (await listRunMessages(run.id)).length;
    await consumeChatInput(first, { kind: "ack", id: input.id });
    await consumeChatInput(first, { kind: "ack", id: input.id });
    assert.equal((await listRunMessages(run.id)).length, before + 1);
    assert.equal((await consumeChatInput(first, { kind: "claim", claimId: randomUUID() })).id, secondInput.id);
    await consumeChatInput(first, { kind: "uncertain", id: secondInput.id, error: "Lost acknowledgement" });
    assert.equal(await consumeChatInput(first, { kind: "claim", claimId: randomUUID(), closeIfEmpty: true }), null);
    await assert.rejects(enqueueChatInput(run.id, alice, { ...input, id: randomUUID() }), /finishing/);
    assert.deepEqual((await listChatInputs(run.id)).map(item => item.status), ["delivered", "unconfirmed", "cancelled"]);
  });
  await test("offers wait for the current durable turn boundary", async () => {
    await changeHandoff(run.id, roomId, alice, { action: "offer", toUserId: bob, note: "Finish the red button", version: 0 });
    const offer = (await handoffState(run.id, roomId)).offers[0];
    await assert.rejects(changeHandoff(run.id, roomId, bob, { action: "accept", handoffId: offer.id, version: 0 }), /active turn/);
  });
  let firstSha;
  await test("a candidate from the member's computer is verified, then promoted", async () => {
    firstSha = await commitOnComputer(roomId, first.turnId, first.baseSha, work => writeFile(join(work, "shared.txt"), "first turn\n"), author);
    assert.equal((await readCommittedBytes(roomId, seed.headSha, "shared.txt")).toString(), "initial\n");
    assert.equal((await complete(first, firstSha)).headSha, firstSha);
    assert.equal((await readCommittedBytes(roomId, firstSha, "shared.txt")).toString(), "first turn\n");
  });
  await test("completion retries do not append duplicate transcript messages", async () => {
    const before = (await listRunMessages(run.id)).length;
    await complete(first, firstSha, "A different retry body must not replace the stored report");
    assert.equal((await listRunMessages(run.id)).length, before);
  });
  await test("acceptance is permission checked, atomic, and idempotent", async () => {
    const offer = (await handoffState(run.id, roomId)).offers[0];
    await assert.rejects(changeHandoff(run.id, roomId, viewer, { action: "accept", handoffId: offer.id, version: 0 }));
    await assert.rejects(changeHandoff(run.id, roomId, carol, { action: "accept", handoffId: offer.id, version: 0 }));
    await changeHandoff(run.id, roomId, bob, { action: "accept", handoffId: offer.id, version: 0 });
    await changeHandoff(run.id, roomId, bob, { action: "accept", handoffId: offer.id, version: 0 });
    const updated = await getRun(run.id);
    assert.equal(updated.driverUserId, bob);
    assert.equal(updated.startedBy, alice);
    assert.equal(updated.controlVersion, 1);
    await assert.rejects(reserveTurn(run.id, alice, randomUUID(), 0));
  });
  await test("continuation includes the transcript and handoff with memory disabled", async () => {
    await appendMessage({ runId: run.id, role: "user", authorUserId: alice, body: "Keep the component accessible" });
    const prompt = assembleAgentPrompt({ prompt: "Continue", conversationContext: await continuationContext(run.id) });
    assert.match(prompt, /Finish the red button/);
    assert.match(prompt, /Keep the component accessible/);
    assert.match(prompt, /first turn|Done/);
  });
  let second;
  let deviceId;
  await test("second turn in the same chat has a distinct job; two devices yield one claim", async () => {
    second = makeJob(randomUUID(), bob, 1, firstSha);
    await reserveTurn(run.id, bob, second.turnId, 1);
    await prepareTurn(second);
    await enqueueLocalJob(second, bob);
    await enqueueLocalJob(second, bob);
    const devices = [];
    for (const name of ["laptop", "desktop"]) devices.push((await sql(`INSERT INTO runner_devices(user_id,name,token_hash,version,agent_ids) VALUES ($1,$2,$3,'2',ARRAY['codex']) RETURNING id`, [bob, name, Buffer.from(randomUUID())])).rows[0].id);
    const claims = await Promise.all(devices.map(id => claimNextJob({ userId: bob, deviceId: id })));
    assert.equal(claims.filter(Boolean).length, 1);
    deviceId = devices[claims.findIndex(Boolean)];
    assert.equal((await claimedJob(second.turnId, deviceId)).runId, run.id);
    await renewLease(second.turnId, deviceId);
    await complete(second);
    await complete(second);
  });
  await test("concurrent open-offer acceptance has exactly one winner", async () => {
    await changeHandoff(run.id, roomId, bob, { action: "offer", toUserId: null, note: "Open", version: 1 });
    const offer = (await handoffState(run.id, roomId)).offers[0];
    await assert.rejects(changeHandoff(run.id, roomId, carol, { action: "decline", handoffId: offer.id, version: 1 }));
    const outcomes = await Promise.allSettled([alice, carol].map(actor => changeHandoff(run.id, roomId, actor, { action: "accept", handoffId: offer.id, version: 1 })));
    assert.equal(outcomes.filter(outcome => outcome.status === "fulfilled").length, 1);
  });
  await test("message sequence allocation survives concurrent appends", async () => {
    const messages = await Promise.all(Array.from({ length: 12 }, (_, index) => appendMessage({ runId: run.id, role: "system", body: `Notice ${index}` })));
    assert.equal(new Set(messages.map(message => message.seq)).size, 12);
  });
  await test("candidate promotion refuses stale bases and preserves newer editor changes", async () => {
    const turnId = randomUUID();
    const candidate = await commitOnComputer(roomId, turnId, firstSha, work => writeFile(join(work, "shared.txt"), "stale agent\n"), author);
    const saved = await mergeSave(roomId, "shared.txt", "first turn\n", "new editor\n", firstSha, author);
    await assert.rejects(promoteTurn(roomId, turnId, firstSha, candidate), /changed during/);
    assert.equal((await readCommittedBytes(roomId, saved.headSha, "shared.txt")).toString(), "new editor\n");
  });
  await test("imported repos with identical paths remain isolated and reject foreign IDs", async () => {
    const imported = await createRoomRepo({ sessionId: roomId, rootName: "import", createdBy: alice });
    await createRepo(imported.id);
    await writeSeedBatch(imported.id, [{ path: "shared.txt", data: Buffer.from("imported\n").toString("base64") }]);
    const initial = await finishSeed(imported.id, "import");
    await finishRoomRepoSeed(imported.id, { headSha: initial.headSha, upstreamUrl: null });
    const request = new Request(`http://localhost/tree?repoId=${imported.id}`);
    const context = await repositoryContext({ id: roomId, repo: seed }, request);
    assert.equal(context.ref, imported.id);
    const tree = await listCommittedTree(context.ref, context.rootName, context.headSha);
    assert.ok(JSON.stringify(tree).includes("shared.txt"));
    const saved = await mergeSave(imported.id, "shared.txt", "imported\n", "changed import\n", initial.headSha, author);
    assert.equal((await committedChanges(imported.id, initial.headSha, saved.headSha))[0].path, "shared.txt");
    const foreign = await repositoryContext({ id: "otherroomxyz", repo: seed }, request);
    assert.equal(foreign.status, 404);
  });
  await test("push protocol accepts one candidate ref and refuses canonical or multiple ref updates", async () => {
    const turnId = randomUUID();
    const packet = ref => { const command = `${"0".repeat(40)} ${"a".repeat(40)} ${ref}\0report-status\n`; return `${(command.length + 4).toString(16).padStart(4, "0")}${command}`; };
    const packHeader = Buffer.alloc(12); packHeader.write("PACK"); packHeader.writeUInt32BE(2, 4);
    const safe = Buffer.concat([Buffer.from(`${packet(`refs/turns/${turnId}`)}0000`), packHeader]);
    const stream = await candidatePush(Readable.from([safe.subarray(0, 3), safe.subarray(3)]), turnId);
    const chunks = []; for await (const chunk of stream) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), safe);
    const excessive = Buffer.from(safe); excessive.writeUInt32BE(250001, excessive.length - 4);
    await assert.rejects(candidatePush(Readable.from([excessive]), turnId), /object limit/);
    await assert.rejects(candidatePush(Readable.from([safe.subarray(0, safe.length - 1)]), turnId), /Incomplete Git pack/);
    const refOnly = safe.subarray(0, safe.length - 12);
    const existing = await candidatePush(Readable.from([refOnly]), turnId);
    const existingChunks = []; for await (const chunk of existing) existingChunks.push(chunk);
    assert.deepEqual(Buffer.concat(existingChunks), refOnly);

    await assert.rejects(candidatePush(Readable.from([packet("refs/heads/session/test") + "0000PACK"]), turnId));
    await assert.rejects(candidatePush(Readable.from([packet(`refs/turns/${turnId}`) + packet("refs/heads/main") + "0000PACK"]), turnId));
  });
  await test("a failed or conflicted save cannot report a successful flush", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ error: "offline" }), { status: 503 });
    try {
      const saver = createSaver(roomId, undefined, undefined, undefined, "imported");
      saver.queue("same.txt", "new", "old");
      assert.equal(await saver.flush(), false);
      let requested;
      globalThis.fetch = async url => { requested = url; return Response.json({ headSha: "abc", committed: true }); };
      assert.equal(await saver.flush(), true);
      assert.match(requested, /repoId=imported/);
    } finally { globalThis.fetch = originalFetch; }
  });
  await test("cancellation is idempotent and expired offers cannot be accepted", async () => {
    const target = await createRun({ sessionId: roomId, startedBy: alice, agentId: "codex", baseSha: seed.headSha });
    await changeHandoff(target.id, roomId, alice, { action: "offer", toUserId: bob, note: "Cancel me", version: 0 });
    const offer = (await handoffState(target.id, roomId)).offers[0];
    await assert.rejects(changeHandoff(target.id, roomId, alice, { action: "offer", toUserId: bob, note: "Duplicate", version: 0 }));
    await changeHandoff(target.id, roomId, alice, { action: "cancel", handoffId: offer.id, version: 0 });
    await changeHandoff(target.id, roomId, alice, { action: "cancel", handoffId: offer.id, version: 0 });
    await changeHandoff(target.id, roomId, alice, { action: "offer", toUserId: bob, note: "Expire me", version: 0 });
    await sql(`UPDATE run_handoffs SET expires_at = now() - interval '1 second' WHERE run_id = $1 AND status = 'pending'`, [target.id]);
    const expired = (await handoffState(target.id, roomId)).offers.find(offer => offer.status === "expired");
    assert.ok(expired);
    await assert.rejects(changeHandoff(target.id, roomId, bob, { action: "accept", handoffId: expired.id, version: 0 }));
  });
  await test("acceptance racing a new submission has one ordered winner", async () => {
    const target = await createRun({ sessionId: roomId, startedBy: alice, agentId: "codex", baseSha: seed.headSha });
    await changeHandoff(target.id, roomId, alice, { action: "offer", toUserId: bob, note: "Race", version: 0 });
    const offer = (await handoffState(target.id, roomId)).offers[0];
    const turnId = randomUUID();
    const outcomes = await Promise.allSettled([
      reserveTurn(target.id, alice, turnId, 0),
      changeHandoff(target.id, roomId, bob, { action: "accept", handoffId: offer.id, version: 0 }),
    ]);
    assert.equal(outcomes.filter(outcome => outcome.status === "fulfilled").length, 1);
    await failTurn(turnId, "Test cleanup");
  });
  await test("revoked recipients disappear and cannot accept a previously addressed offer", async () => {
    const target = await createRun({ sessionId: roomId, startedBy: alice, agentId: "codex", baseSha: seed.headSha });
    await changeHandoff(target.id, roomId, alice, { action: "offer", toUserId: bob, note: "Permissions", version: 0 });
    const offer = (await handoffState(target.id, roomId)).offers[0];
    await sql(`UPDATE session_members SET removed_at = now() WHERE session_id = $1 AND user_id = $2`, [roomId, bob]);
    assert.ok(!(await handoffState(target.id, roomId)).recipients.some(person => person.id === bob));
    await assert.rejects(changeHandoff(target.id, roomId, bob, { action: "accept", handoffId: offer.id, version: 0 }));
    await sql(`UPDATE session_members SET removed_at = NULL WHERE session_id = $1 AND user_id = $2`, [roomId, bob]);
  });
  await test("lease expiry and owner recovery fence late events and completion", async () => {
    const target = await createRun({ sessionId: roomId, startedBy: alice, agentId: "codex", baseSha: seed.headSha });
    const job = { ...makeJob(randomUUID(), alice, 0), runId: target.id };
    await reserveTurn(target.id, alice, job.turnId, 0);
    await prepareTurn(job);
    await enqueueLocalJob(job, alice);
    const device = (await sql(`INSERT INTO runner_devices(user_id,name,token_hash,version,agent_ids) VALUES ($1,'recovery',$2,'2',ARRAY['codex']) RETURNING id`, [alice, Buffer.from(randomUUID())])).rows[0].id;
    await claimNextJob({ userId: alice, deviceId: device });
    await assert.rejects(changeHandoff(target.id, roomId, alice, { action: "recover", version: 0 }));
    await sql(`UPDATE runner_jobs SET lease_expires_at = now() - interval '1 second' WHERE turn_id = $1`, [job.turnId]);
    assert.equal(await claimedJob(job.turnId, device), null);
    await changeHandoff(target.id, roomId, alice, { action: "recover", version: 0 });
    await assert.rejects(complete(job));
    assert.equal((await getRun(target.id)).controlVersion, 1);
    const next = randomUUID();
    await reserveTurn(target.id, alice, next, 1);
    await failTurn(next, "Test cleanup");
  });
  await test("interrupted promotion reconciles from the durable completion without rerunning an agent", async () => {
    const base = await headSha(roomId);
    const target = await createRun({ sessionId: roomId, startedBy: alice, agentId: "codex", baseSha: base });
    const job = { ...makeJob(randomUUID(), alice, 0, base), runId: target.id };
    await reserveTurn(target.id, alice, job.turnId, 0);
    await prepareTurn(job);
    await claimTurn(sql, job);
    const sha = await commitOnComputer(roomId, job.turnId, base, work => writeFile(join(work, "reconciled.txt"), "Durable result\n"), author);
    const report = { turnId: job.turnId, runId: target.id, sessionId: roomId, repoId: null, baseSha: base,
      userPrompt: "Recover", binName: "codex", author, sha, code: 0, output: "Recovered once", errOutput: "" };
    await sql(`UPDATE agent_turns SET completion = $2 WHERE id = $1`, [job.turnId, JSON.stringify(report)]);
    await promoteTurn(roomId, job.turnId, base, sha);
    assert.equal((await finalizeAgentRun(report)).headSha, sha);
    await finalizeAgentRun(report);
    assert.equal((await listRunMessages(target.id)).filter(message => message.body === "Recovered once").length, 1);
  });
  await test("effective project access includes implicit editors and refuses suspension, removal, and private rooms", async () => {
    const orgId = (await sql(`INSERT INTO orgs(slug,name,created_by) VALUES ('handoff-org','Handoff org',$1) RETURNING id`, [alice])).rows[0].id;
    await sql(`INSERT INTO org_members(org_id,user_id,role) VALUES ($1,$2,'owner'),($1,$3,'member')`, [orgId, alice, bob]);
    const projectId = (await sql(`INSERT INTO projects(org_id,slug,name,created_by) VALUES ($1,'handoff-project','Handoff project',$2) RETURNING id`, [orgId, alice])).rows[0].id;
    await sql(`INSERT INTO project_members(project_id,org_id,user_id,role) VALUES ($1,$2,$3,'editor')`, [projectId, orgId, bob]);
    await sql(`INSERT INTO sessions(id,name,join_code,owner_id,org_id,project_id) VALUES ('projectrooms','Project room','ABCD-MNPQ',$1,$2,$3)`, [alice, orgId, projectId]);
    const role = async () => (await sql(`SELECT room_access_role('projectrooms',$1) AS role`, [bob])).rows[0].role;
    assert.equal(await role(), "editor");
    await sql(`UPDATE sessions SET visibility = 'private' WHERE id = 'projectrooms'`);
    assert.equal(await role(), null);
    await sql(`INSERT INTO session_members(session_id,user_id,role,added_via) VALUES ('projectrooms',$1,'editor','owner')`, [bob]);
    assert.equal(await role(), "editor");
    await sql(`UPDATE project_members SET role = 'viewer' WHERE project_id = $1 AND user_id = $2`, [projectId, bob]);
    assert.equal(await role(), "viewer");
    await sql(`UPDATE org_members SET status = 'suspended' WHERE org_id = $1 AND user_id = $2`, [orgId, bob]);
    assert.equal(await role(), null);
    await sql(`UPDATE org_members SET status = 'active' WHERE org_id = $1 AND user_id = $2`, [orgId, bob]);
    await sql(`UPDATE project_members SET removed_at = now() WHERE project_id = $1 AND user_id = $2`, [projectId, bob]);
    assert.equal(await role(), null);
  });
  await test("runner outbox retains failed or malformed reports and delivers other completions without replay", async () => {
    const data = join(directory, "outbox-check");
    const delivered = randomUUID();
    const failed = randomUUID();
    const malformed = randomUUID();
    const report = { code: 0, resultSha: null, output: "Done", errOutput: "", ms: 10 };
    await storeCompletion(data, delivered, report);
    await storeCompletion(data, failed, report);
    await writeFile(join(data, "outbox", `${malformed}.json`), "{");
    const calls = [];
    await deliverCompletions(data, { async complete(turnId, value) {
      calls.push(turnId);
      assert.deepEqual(value, report);
      if (turnId === failed) throw new Error("Simulated network outage");
    } });
    assert.deepEqual(calls.sort(), [delivered, failed].sort());
    await assert.rejects(readFile(join(data, "outbox", `${delivered}.json`)), { code: "ENOENT" });
    assert.deepEqual(JSON.parse(await readFile(join(data, "outbox", `${failed}.json`), "utf8")), report);
    assert.equal(await readFile(join(data, "outbox", `${malformed}.json`), "utf8"), "{");
    const retried = [];
    await deliverCompletions(data, { async complete(turnId) { retried.push(turnId); } });
    assert.deepEqual(retried, [failed]);
  });
  await test("model-aware routing only claims on the owner's device advertising the exact model and effort", async () => {
    const target = await createRun({ sessionId: roomId, startedBy: carol, agentId: "opencode", baseSha: seed.headSha });
    const job = { ...makeJob(randomUUID(), carol, 0), runId: target.id, agentId: "opencode", model: "provider/new-model", effort: "high" };
    await reserveTurn(target.id, carol, job.turnId, 0);
    await prepareTurn(job); await enqueueLocalJob(job, carol);
    const device = async catalog => (await sql(`INSERT INTO runner_devices(user_id,name,token_hash,version,agent_ids,model_catalog) VALUES ($1,'model-router',$2,'2',ARRAY['opencode'],$3) RETURNING id`, [carol, Buffer.from(randomUUID()), JSON.stringify(catalog)])).rows[0].id;
    const wrong = await device({ opencode: { choices: [{ id: "provider/old-model", efforts: [{ id: "high" }] }] } });
    const missingEffort = await device({ opencode: { choices: [{ id: "provider/new-model", efforts: [] }] } });
    const right = await device({ opencode: { choices: [{ id: "provider/new-model", efforts: [{ id: "high" }] }] } });
    assert.equal(await claimNextJob({ userId: carol, deviceId: wrong }), null);
    assert.equal(await claimNextJob({ userId: carol, deviceId: missingEffort }), null);
    assert.equal(await claimNextJob({ userId: bob, deviceId: right }), null);
    assert.equal((await claimNextJob({ userId: carol, deviceId: right })).job.turnId, job.turnId);
    await failTurn(job.turnId, "Test cleanup");
    assert.equal((await sql(`SELECT runner_supports_model('{}','ollama','',NULL) AS allowed`)).rows[0].allowed, false);
    assert.equal((await sql(`SELECT runner_supports_model('{}','codex',NULL,NULL) AS allowed`)).rows[0].allowed, true);
    assert.equal((await sql(`SELECT runner_supports_model('{}','codex','unadvertised',NULL) AS allowed`)).rows[0].allowed, false);
  });
  await test("persistent runner worktree candidates finalize and continue through the real server state machine", async () => {
    const acceptedHead = async () => (await sql(`SELECT head_sha FROM session_repos WHERE session_id = $1`, [roomId])).rows[0].head_sha;
    const base = await acceptedHead();
    const target = await createRun({ sessionId: roomId, startedBy: alice, agentId: "codex", baseSha: base });
    const remoteRoot = join(directory, "worktree-transport");
    await mkdir(join(remoteRoot, "api", "git"), { recursive: true });
    await symlink(barePath(roomId), join(remoteRoot, "api", "git", roomId), "junction");
    const local = new RunnerGit(pathToFileURL(remoteRoot).href, "fixture", join(directory, "worktree-runner"));
    let previous = base;
    let workspacePath;
    for (let index = 0; index < 2; index += 1) {
      const job = { ...makeJob(randomUUID(), alice, 0, previous), runId: target.id };
      await reserveTurn(target.id, alice, job.turnId, 0);
      await prepareTurn(job);
      await claimTurn(sql, job);
      const sha = await local.withWorkspace(job, async workspace => {
        if (workspacePath) assert.equal(workspace.path, workspacePath);
        workspacePath = workspace.path;
        await writeFile(join(workspace.path, `worktree-${index}.txt`), `Turn ${index}\n`);
        return workspace.commitAndPush("Worktree integration", author);
      });
      assert.equal(await acceptedHead(), previous, "candidate alone cannot advance the room");
      const result = await complete(job, sha);
      assert.equal(result.status, "completed");
      assert.equal(result.headSha, sha);
      assert.equal(await acceptedHead(), sha);
      assert.equal((await complete(job, sha)).headSha, sha, "duplicate completion remains idempotent");
      previous = sha;
    }
    assert.equal((await readCommittedBytes(roomId, previous, "worktree-0.txt")).toString(), "Turn 0\n");
    assert.equal((await readCommittedBytes(roomId, previous, "worktree-1.txt")).toString(), "Turn 1\n");
  });
  await test("object-only imports honor root and nested Git ignores across batches without a checkout", async () => {
    const id = "ignoredimport";
    await createRepo(id);
    const batch = files => writeSeedBatch(id, Object.entries(files).map(([path,text]) => ({path,data:Buffer.from(text).toString("base64")})));
    await batch({"generated/large.txt":"ignored", "secret.txt":"ignored", "src/local.txt":"ignored", "src/keep.txt":"keep"});
    await batch({".gitignore":"generated/\nsecret.txt\n", "src/.gitignore":"*.txt\n!keep.txt\n"});
    const result = await finishSeed(id,"Ignored import");
    assert.equal(await readCommittedBytes(id,result.headSha,"secret.txt"),null);
    assert.equal(await readCommittedBytes(id,result.headSha,"generated/large.txt"),null);
    assert.equal(await readCommittedBytes(id,result.headSha,"src/local.txt"),null);
    assert.equal((await readCommittedBytes(id,result.headSha,"src/keep.txt")).toString(),"keep");
    await assert.rejects(stat(workPath(id)),{code:"ENOENT"});
  });
  await test("durable activity survives retries, rejects gaps and mismatched content, and omits private thinking", async () => {
    const target = await createRun({ sessionId: roomId, startedBy: alice, agentId: "codex", baseSha: await headSha(roomId) });
    const id = randomUUID(); await reserveTurn(target.id, alice, id, 0);
    const events = [{ t: "act", d: "Read component" }, { t: "out", d: "Working on the button" }, { t: "think", d: "private" }];
    assert.equal(await persistActivity(id, 1, events), true);
    assert.equal(await persistActivity(id, 1, events), false);
    await assert.rejects(persistActivity(id, 1, [{ t: "out", d: "changed" }]));
    await assert.rejects(persistActivity(id, 3, events));
    await persistActivity(id, 2, [{ t: "err", d: "Test failed" }]);
    const page = await activityPage(id, 0);
    assert.equal(page.length, 2); assert.equal(page[0].events.length, 2);
    assert.doesNotMatch(JSON.stringify(page), /private/);
    assert.equal((await activityPage(id, 1))[0].sequence, 2);
    await failTurn(id, "Interrupted laptop");
    // Uploads already queued on that device may append history after interruption.
    await persistActivity(id, 3, [{ t: "notice", message: "Last saved output" }]);
    assert.equal((await activityPage(id, 2))[0].events[0].message, "Last saved output");
  });
  await test("activity outbox retries in sequence after a runner restart", async () => {
    const local = new ActivityOutbox(directory, "server", "token");
    const id = randomUUID(); local.store(id, 1, [{t:"out",d:"first"}]); local.store(id, 2, [{t:"out",d:"second"}]);
    let calls = [];
    await local.deliver({postEvents: async (_id,_events,seq) => { calls.push(seq); throw new Error("offline"); }});
    assert.deepEqual(calls, [1]); calls = [];
    await new ActivityOutbox(directory,"server","token").deliver({postEvents: async (_id,_events,seq) => { calls.push(seq); }});
    assert.deepEqual(calls, [1,2]);
  });
  await test("uploaded checkpoints remain readable with the laptop offline and cannot be attached to another turn", async () => {
    const base = await headSha(roomId);
    const target = await createRun({ sessionId: roomId, startedBy: alice, agentId: "codex", baseSha: base });
    const job = {...makeJob(randomUUID(),alice,0,base), runId:target.id};
    await reserveTurn(target.id,alice,job.turnId,0); await prepareTurn(job);
    const device = (await sql(`INSERT INTO runner_devices(user_id,name,token_hash) VALUES ($1,'snapshots',$2) RETURNING id`,[alice,Buffer.from(randomUUID())])).rows[0].id;
    const local = new RunnerGit(pathToFileURL(join(directory,"worktree-transport")).href,"checkpoints",join(directory,"checkpoint-runner"));
    let captured;
    await local.withWorkspace(job,async w => { await writeFile(join(w.path,"unfinished.txt"),"available offline"); await w.checkpoint(); });
    await local.deliverCheckpoints({checkpoint:async snapshot => { captured=snapshot; await saveCheckpoint(job,device,snapshot); }});
    assert.ok(captured);
    const rows = await listCheckpoints(target.id); assert.equal(rows.length,1);
    assert.equal((await readCommittedBytes(roomId,rows[0].snapshotSha,"unfinished.txt")).toString(),"available offline");
    await saveCheckpoint(job,device,captured); assert.equal((await listCheckpoints(target.id)).length,1);
    await assert.rejects(saveCheckpoint({...job,turnId:randomUUID()},device,captured));
    assert.equal(await getCheckpoint(captured.id,randomUUID()),null);
    await failTurn(job.turnId,"Laptop switched off");
  });
  await test("cold Git archives restore every ref and pinned repositories cannot be evicted", async () => {
    process.env.STORAGE_COLD_GIT="1";
    try {
      const before=await objectText(barePath(roomId),["for-each-ref","--format=%(refname) %(objectname)"]);
      await withStoredRepo(barePath(roomId),async () => assert.equal(await archiveStoredRepo(barePath(roomId)),false));
      assert.equal(await archiveStoredRepo(barePath(roomId)),true);
      await assert.rejects(stat(barePath(roomId)),{code:"ENOENT"});
      const restored=await headSha(roomId); assert.ok(restored);
      assert.equal(await objectText(barePath(roomId),["for-each-ref","--format=%(refname) %(objectname)"]),before);
      assert.ok((await listCommittedTree(roomId,"repo",restored)).children.length);
      const bare=barePath(roomId);
      await objectText(bare,["update-ref","refs/heads/release",restored]);
      await objectText(bare,["symbolic-ref","HEAD","refs/heads/release"]);
      assert.equal(await archiveStoredRepo(bare),true);
      await withStoredRepo(bare,async()=>{
        assert.equal(await objectText(bare,["symbolic-ref","HEAD"]),"refs/heads/release");
        assert.equal(await objectText(bare,["rev-parse","HEAD"]),restored);
      });
      const tree=await objectText(bare,["rev-parse",`${restored}^{tree}`]);
      const detached=await objectText(bare,["commit-tree",tree,"-p",restored,"-m","Detached archive test"]);
      await objectText(bare,["update-ref","--no-deref","HEAD",detached]);
      assert.equal(await archiveStoredRepo(bare),true);
      await withStoredRepo(bare,async()=>{
        assert.equal(await objectText(bare,["rev-parse","HEAD"]),detached);
        await assert.rejects(objectText(bare,["symbolic-ref","-q","HEAD"]));
        await objectText(bare,["symbolic-ref","HEAD","refs/heads/main"]);
      });
    } finally { delete process.env.STORAGE_COLD_GIT; }
  });
  await test("failed executions close pending input and preserve uncertain deliveries without replay", async () => {
    const target = await createRun({sessionId:roomId,startedBy:alice,agentId:"codex",baseSha:seed.headSha});
    const job={...makeJob(randomUUID(),alice,0),runId:target.id};
    await reserveTurn(target.id,alice,job.turnId,0);await prepareTurn(job);await claimTurn(sql,job);
    const firstInput={id:randomUUID(),body:"Possibly received",controlVersion:0};
    await enqueueChatInput(target.id,alice,firstInput);
    await enqueueChatInput(target.id,alice,{id:randomUUID(),body:"Never delivered",controlVersion:0});
    await consumeChatInput(job,{kind:"claim",claimId:randomUUID()});
    await failTurn(job.turnId,"Runner disconnected");
    assert.deepEqual((await listChatInputs(target.id)).map(i=>i.status),["unconfirmed","failed"]);
    await assert.rejects(consumeChatInput(job,{kind:"ack",id:firstInput.id}),/controls/);
    await assert.rejects(enqueueChatInput(target.id,alice,{id:randomUUID(),body:"Too late",controlVersion:0}),/finishing/);
  });
  if (process.env.HANDOFF_TEST_BROWSER === "1") {
    if (!realPostgres) throw new Error("Browser tests require HANDOFF_TEST_POSTGRES=1.");
    const { browserChecks } = await import("./handoff-browser.mjs");
    await browserChecks({ sql, directory, databaseUrl: scopedDatabaseUrl, redisUrl: testRedisUrl,
      roomId, alice, bob, seed });
  }
  console.log(`\n${passed} handoff/repository checks passed (${realPostgres ? "real PostgreSQL, concurrent connections" : "PGlite, serialized transactions"}).`);
} finally {
  await cleanup();
  delete globalThis.__maPool;
  await rm(directory, { recursive: true, force: true });
}
