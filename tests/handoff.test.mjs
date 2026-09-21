import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, mkdir, symlink, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { citext } from "@electric-sql/pglite/contrib/citext";
import pg from "pg";
import { migrate } from "../db/migrate.mjs";
import { createRun, getRun, appendMessage, listRunMessages } from "../app/lib/ai/runs.ts";
import { reserveTurn, prepareTurn, startTurn, failTurn } from "../app/lib/ai/turns.ts";
import { changeHandoff, handoffState, continuationContext } from "../app/lib/ai/handoff.ts";
import { finalizeAgentRun } from "../app/lib/ai/finalize.ts";
import { assembleAgentPrompt } from "../app/lib/ai/prompt.ts";
import { createRepo, finishSeed, writeSeedBatch, prepareTurnWork, commitTurnWork, readCommittedBytes,
  listCommittedTree, mergeSave, writeRepoFile, readRepoFile, promoteTurn, committedChanges, headSha } from "../app/lib/session/repo.ts";
import { workPath } from "../app/lib/session/paths.ts";
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
    assert.equal(await startTurn(first), true);
    assert.equal(await startTurn(first), false);
  });
  await test("offers wait for the current durable turn boundary", async () => {
    await changeHandoff(run.id, roomId, alice, { action: "offer", toUserId: bob, note: "Finish the red button", version: 0 });
    const offer = (await handoffState(run.id, roomId)).offers[0];
    await assert.rejects(changeHandoff(run.id, roomId, bob, { action: "accept", handoffId: offer.id, version: 0 }), /active turn/);
  });
  let firstSha;
  await test("isolated execution promotes only its verified candidate", async () => {
    const work = await prepareTurnWork(roomId, first.turnId, first.baseSha);
    await writeFile(join(work, "shared.txt"), "first turn\n");
    firstSha = await commitTurnWork(roomId, first.turnId, first.baseSha, author);
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
    const work = await prepareTurnWork(roomId, turnId, firstSha);
    await writeFile(join(work, "shared.txt"), "stale agent\n");
    const candidate = await commitTurnWork(roomId, turnId, firstSha, author);
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
  await test("leaf and parent symlinks cannot escape repository reads or writes", async () => {
    const outside = join(directory, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(join(outside, "secret.txt"), join(workPath(roomId), "link.txt"));
    await symlink(outside, join(workPath(roomId), "linked"));
    assert.equal(await readRepoFile(roomId, "link.txt"), null);
    assert.equal(await writeRepoFile(roomId, "link.txt", "bad"), false);
    assert.equal(await writeRepoFile(roomId, "linked/secret.txt", "bad"), false);
    assert.equal(await readFile(join(outside, "secret.txt"), "utf8"), "secret");
  });
  await test("push protocol accepts one candidate ref and refuses canonical or multiple ref updates", async () => {
    const turnId = randomUUID();
    const packet = ref => { const command = `${"0".repeat(40)} ${"a".repeat(40)} ${ref}\0report-status\n`; return `${(command.length + 4).toString(16).padStart(4, "0")}${command}`; };
    const safe = Buffer.from(`${packet(`refs/turns/${turnId}`)}0000PACK`);
    const stream = await candidatePush(Readable.from([safe.subarray(0, 3), safe.subarray(3)]), turnId);
    const chunks = []; for await (const chunk of stream) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), safe);
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
    await startTurn(job);
    const work = await prepareTurnWork(roomId, job.turnId, base);
    await writeFile(join(work, "reconciled.txt"), "Durable result\n");
    const sha = await commitTurnWork(roomId, job.turnId, base, author);
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
    const projectId = (await sql(`INSERT INTO projects(org_id,slug,name,source,created_by) VALUES ($1,'handoff-project','Handoff project','local',$2) RETURNING id`, [orgId, alice])).rows[0].id;
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
