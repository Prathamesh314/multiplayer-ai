// Adding files from the explorer: any bytes, any folder, one commit, and never
// a silent overwrite or an unsafe path. Starts from an empty project, the case
// where there was no way to add a file at all.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { objectText } from "../app/lib/git/objects.ts";
import { addFiles, createRepo, finishSeed, readCommittedBytes } from "../app/lib/session/repo.ts";
import { barePath } from "../app/lib/session/paths.ts";

const author = { name: "Alice", email: "alice@example.test" };

test("an empty project accepts CSV, binary and nested files in one commit", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mp-add-files-"));
  const previous = process.env.MULTIPLAYER_AI_DATA;
  process.env.MULTIPLAYER_AI_DATA = root;
  t.after(async () => {
    if (previous === undefined) delete process.env.MULTIPLAYER_AI_DATA; else process.env.MULTIPLAYER_AI_DATA = previous;
    await rm(root, { recursive: true, force: true });
  });
  const id = "addfilesroom";
  await createRepo(id);
  const seeded = await finishSeed(id, "Empty project");
  const csv = Buffer.from("name,score\nalice,3\nbob,5\n");
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
  const committed = [];
  const first = await addFiles(id, [
    { path: "data/scores.csv", bytes: csv },
    { path: "assets/logo.png", bytes: png },
    { path: "notes/.gitkeep", bytes: Buffer.alloc(0) },
  ], false, author, async (sha) => { committed.push(sha); });
  assert.equal(first.status, "clean");
  assert.deepEqual(first.added.sort(), ["assets/logo.png", "data/scores.csv", "notes/.gitkeep"]);
  assert.deepEqual(committed, [first.headSha], "the new head is recorded once");
  assert.equal((await objectText(barePath(id), ["rev-list", "--count", `${seeded.headSha}..${first.headSha}`])), "1", "one commit for the whole batch");
  assert.equal((await objectText(barePath(id), ["log", "-1", "--format=%an <%ae>|%s", first.headSha])), "Alice <alice@example.test>|Add 3 files");
  assert.deepEqual(await readCommittedBytes(id, first.headSha, "data/scores.csv"), csv);
  assert.deepEqual(await readCommittedBytes(id, first.headSha, "assets/logo.png"), png, "binary bytes are kept exactly");

  // An existing file is never replaced silently.
  const again = await addFiles(id, [{ path: "data/scores.csv", bytes: Buffer.from("x\n") }, { path: "data/new.csv", bytes: Buffer.from("y\n") }], false, author);
  assert.deepEqual(again, { status: "exists", headSha: first.headSha, paths: ["data/scores.csv"] });
  assert.equal(await objectText(barePath(id), ["rev-parse", "refs/heads/session/addfilesroom"]), first.headSha, "nothing was written");
  const replaced = await addFiles(id, [{ path: "data/scores.csv", bytes: Buffer.from("x\n") }, { path: "data/new.csv", bytes: Buffer.from("y\n") }], true, author);
  assert.equal(replaced.status, "clean");
  assert.deepEqual(replaced.replaced, ["data/scores.csv"]);
  assert.deepEqual(replaced.added, ["data/new.csv"]);
  assert.equal((await readCommittedBytes(id, replaced.headSha, "data/scores.csv")).toString(), "x\n");

  // Unsafe or impossible paths are refused.
  for (const [files, message] of [
    [[{ path: "../escape.txt", bytes: csv }], /valid file path/],
    [[{ path: ".git/config", bytes: csv }], /valid file path/],
    [[{ path: "data", bytes: csv }], /folder named data already exists/],
    [[{ path: "data/scores.csv/inner.txt", bytes: csv }], /is a file, so it cannot hold/],
    [[{ path: "a.txt", bytes: csv }, { path: "A.txt", bytes: csv }], /listed twice/],
    [[{ path: "big.bin", bytes: Buffer.alloc(8 * 1024 * 1024 + 1) }], /larger than 8 MB/],
    [[], /between 1 and 100/],
  ]) await assert.rejects(addFiles(id, files, true, author), message);
});
