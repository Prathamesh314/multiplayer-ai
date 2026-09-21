/**
 * Git-correctness tests for the project/room fork–merge model.
 *
 * This is the layer where a bug means silent data loss or one room's work
 * landing in another's — the one thing a multiplayer coding product cannot
 * afford. So these run the real functions against real git in a throwaway data
 * root, exercising the paths that matter: a room forking from the project,
 * publishing back to the shared `main`, a second room converging without losing
 * either side's work, and a genuine conflict aborting cleanly with both sides
 * left exactly as they were.
 *
 * Run with `npm run test:repo` — it compiles the TypeScript first.
 */
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, dirname } = require("node:path");

// A fresh data root per run, before anything reads it (dataRoot() reads the env
// on each call, so setting it here is enough).
const DATA = mkdtempSync(join(tmpdir(), "mp-repo-test-"));
process.env.MULTIPLAYER_AI_DATA = DATA;

const repo = require("../.test-build/session/repo.js");
const { workPath, projectBarePath } = require("../.test-build/session/paths.js");

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`      ${err && err.message ? err.message : err}`);
  }
}

// --- helpers ---------------------------------------------------------------

/** Author identity for a room's commit, so `git log` stays meaningful. */
const author = (name) => [`${name}`, `${name.toLowerCase()}@example.com`];

/** Write a file into a room's working copy (does not commit). */
function put(roomId, rel, contents) {
  const abs = join(workPath(roomId), rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, contents);
}

/** Read a file from a room's working copy, or null if absent. */
function readWork(roomId, rel) {
  const abs = join(workPath(roomId), rel);
  return existsSync(abs) ? readFileSync(abs, "utf8") : null;
}

/** Read a path at the project's canonical `main`, or null if absent there. */
function readProjectMain(projectId, rel) {
  try {
    return execFileSync("git", ["--git-dir", projectBarePath(projectId), "show", `main:${rel}`], {
      encoding: "utf8",
    });
  } catch {
    return null;
  }
}

/** Edit a file in a room, commit it as `who`, and return nothing. */
async function editAndCommit(roomId, rel, contents, who) {
  put(roomId, rel, contents);
  const [name, email] = author(who);
  const sha = await repo.commitWork(roomId, `${who}: ${rel}`, name, email);
  assert.ok(sha, `commitWork should return a sha for ${roomId}/${rel}`);
}

// --- scenarios -------------------------------------------------------------

async function run() {
  console.log("repo.ts git-correctness");

  await test("a room forks from the project and starts on its own branch", async () => {
    const p = "proj1";
    await repo.ensureProjectRepo(p);
    const before = await repo.projectHeadSha(p);
    assert.ok(before, "project main should exist after ensureProjectRepo");

    const r = await repo.forkRoomFromProject("p1-ra", p, "root");
    assert.equal(r.baseBranch, "main");
    assert.equal(r.sessionBranch, "session/p1-ra");
    assert.equal(r.headSha, r.baseShaAtFork, "a fresh fork starts level with base");
  });

  await test("publishing a room fast-forwards the project's main", async () => {
    const p = "02000000-0000-4000-8000-000000000002";
    await repo.ensureProjectRepo(p);
    const before = await repo.projectHeadSha(p);

    await repo.forkRoomFromProject("p2-ra", p, "root");
    await editAndCommit("p2-ra", "a.txt", "A1", "Alice");

    const res = await repo.publishRoom("p2-ra", p);
    assert.ok(res.ok, `publish should succeed, got ${JSON.stringify(res)}`);

    const after = await repo.projectHeadSha(p);
    assert.notEqual(after, before, "project main should advance after publish");
    assert.equal(readProjectMain(p, "a.txt"), "A1", "published file should be on project main");
    assert.equal(await repo.repoContainsCommit(p, before, after), true, "published head contains the original commit");
    assert.equal(await repo.repoContainsCommit(p, after, before), false, "the older head cannot approve a later commit");
    await assert.rejects(repo.repoContainsCommit(p, "not-a-sha", after), /Invalid commit SHA/);
  });

  await test("two rooms editing different files converge with no lost work", async () => {
    const p = "proj3";
    await repo.ensureProjectRepo(p);

    // Both fork from the same initial main, before either publishes.
    await repo.forkRoomFromProject("p3-ra", p, "root");
    await repo.forkRoomFromProject("p3-rb", p, "root");

    // Room A publishes first.
    await editAndCommit("p3-ra", "a.txt", "A1", "Alice");
    const pubA = await repo.publishRoom("p3-ra", p);
    assert.ok(pubA.ok, "A publishes cleanly");

    // Room B, still forked from the old main, publishes second: publishRoom must
    // pull A's main in, merge, and push — carrying BOTH files, losing neither.
    await editAndCommit("p3-rb", "b.txt", "B1", "Bob");
    const pubB = await repo.publishRoom("p3-rb", p);
    assert.ok(pubB.ok, `B publishes cleanly after merging A, got ${JSON.stringify(pubB)}`);

    assert.equal(readProjectMain(p, "a.txt"), "A1", "A's file survives B's publish");
    assert.equal(readProjectMain(p, "b.txt"), "B1", "B's file is published");

    // Syncing A back pulls B's file into A without leaving the room.
    const syncA = await repo.syncRoom("p3-ra", p);
    assert.ok(syncA.ok, "A syncs cleanly");
    assert.equal(readWork("p3-ra", "a.txt"), "A1", "A keeps its own work after sync");
    assert.equal(readWork("p3-ra", "b.txt"), "B1", "A receives B's work after sync");
  });

  await test("conflicting publishes abort cleanly, leaving both sides intact", async () => {
    const p = "proj4";
    await repo.ensureProjectRepo(p);

    // Seed a shared file on main via room C, so both later rooms fork with it.
    await repo.forkRoomFromProject("p4-seed", p, "root");
    await editAndCommit("p4-seed", "shared.txt", "base\n", "Seed");
    assert.ok((await repo.publishRoom("p4-seed", p)).ok);

    await repo.forkRoomFromProject("p4-rc", p, "root");
    await repo.forkRoomFromProject("p4-rd", p, "root");

    // Both edit the same line; C publishes first and wins main.
    await editAndCommit("p4-rc", "shared.txt", "from-C\n", "Carol");
    assert.ok((await repo.publishRoom("p4-rc", p)).ok, "C publishes first");
    const mainAfterC = await repo.projectHeadSha(p);

    // D's publish must conflict on the same line and abort — reporting the file,
    // touching neither the project main nor D's own working copy.
    await editAndCommit("p4-rd", "shared.txt", "from-D\n", "Dave");
    const pubD = await repo.publishRoom("p4-rd", p);
    assert.equal(pubD.ok, false, "D's conflicting publish must fail");
    assert.equal(pubD.reason, "conflict");
    assert.deepEqual(pubD.files, ["shared.txt"], "the conflicted file is reported");

    assert.equal(await repo.projectHeadSha(p), mainAfterC, "project main is untouched by the failed publish");
    assert.equal(readProjectMain(p, "shared.txt"), "from-C\n", "main still holds C's version");
    assert.equal(
      readWork("p4-rd", "shared.txt"),
      "from-D\n",
      "D's working copy is left exactly as it was (merge aborted, no conflict markers)",
    );
  });

  await test("per-file diff stats come straight from the bare repo", async () => {
    const p = "proj5";
    await repo.ensureProjectRepo(p);
    await repo.forkRoomFromProject("p5-ra", p, "root");
    const base = await repo.headSha("p5-ra");

    // Two files changed: one brand new, one replacing seeded content.
    put("p5-ra", "fresh.txt", "one\ntwo\nthree\n");
    put("p5-ra", "root/hello.txt", "rewritten\n");
    const [name, email] = author("Eve");
    const sha = await repo.commitWork("p5-ra", "Eve: two files", name, email);
    assert.ok(sha);

    const files = await repo.diffFilesBare("p5-ra", base, sha);
    const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
    assert.equal(files.length, 2, `expected two changed files, got ${JSON.stringify(files)}`);
    assert.equal(byPath["fresh.txt"].added, 3);
    assert.equal(byPath["fresh.txt"].removed, 0);
    assert.ok(byPath["root/hello.txt"], "the rewritten file is named");

    // The totals variant agrees with the per-file sum — one source of truth.
    const totals = await repo.diffStatBare("p5-ra", base, sha);
    assert.equal(totals.added, files.reduce((s, f) => s + f.added, 0));
    assert.equal(totals.removed, files.reduce((s, f) => s + f.removed, 0));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
