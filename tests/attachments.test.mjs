// Attachments as files, not prompt text: names, the upload lifecycle (one-time
// links, exact sizes, quota), sending and binding, visibility, cleanup, the
// runner capability gate, and the runner placing files in a real worktree.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, utimes, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { memoryFixture } from "./helpers/memory-fixture.mjs";
import { deviceFor } from "./helpers/runner-turn.mjs";

const storage = await mkdtemp(join(tmpdir(), "attachments-store-"));
process.env.STORAGE_PROVIDER = "local";
process.env.STORAGE_LOCAL_DIR = storage;
const {
  attachmentFiles, attachmentPromptBlock, bindAttachments, cleanContentType, cleanName, createUpload, discardUpload,
  receiveUpload, roomAttachment, sendableAttachments, sweepAttachments, uploadTokenUser, worktreeNames,
} = await import("../app/lib/ai/attachments.ts");
const { createRun, appendMessage, listRunMessages } = await import("../app/lib/ai/runs.ts");
const { reserveTurn, prepareTurn } = await import("../app/lib/ai/turns.ts");
const { claimNextJob } = await import("../app/lib/runner/jobs.ts");
const { requestUserId } = await import("../app/lib/http/api-limit.ts");
const { attachmentDestination, placeAttachments } = await import("../runner/attachments.ts");

test.after(() => rm(storage, { recursive: true, force: true }));
const body = (text) => new Blob([text]).stream();
const sha = (text) => createHash("sha256").update(text).digest("hex");

test("worktree names are safe on every OS, keep extensions, and never collide", () => {
  assert.deepEqual(worktreeNames(["report.pdf", "Report.PDF", "a/b\\c:d.txt", "..hidden", "CON.txt", "  ", "x".repeat(300) + ".log"]), [
    "report.pdf", "Report-2.PDF", "a_b_c_d.txt", "hidden", "_CON.txt", "file", "x".repeat(100) + ".log",
  ]);
  assert.equal(cleanName("../../etc/passwd"), "passwd");
  assert.equal(cleanName("tab\there\u0000.txt"), "tabhere.txt");
  assert.equal(cleanContentType("Image/PNG; charset=x"), "image/png");
  assert.equal(cleanContentType("not a type"), "application/octet-stream");
});

test("the agent is told where the files are and to read large ones in parts", () => {
  const block = attachmentPromptBlock([
    { id: "1", path: ".multicode/attachments/t/log.txt", size: 3 * 1024 * 1024, sha256: "", contentType: "text/plain" },
    { id: "2", path: ".multicode/attachments/t/shot.png", size: 2048, sha256: "", contentType: "image/png" },
  ]);
  assert.match(block, /<attachments>/);
  assert.match(block, /- \.multicode\/attachments\/t\/log\.txt \(3\.0 MB, text\/plain\)/);
  assert.match(block, /- \.multicode\/attachments\/t\/shot\.png \(2 KB, image\/png\)/);
  assert.match(block, /read large files in parts/);
  assert.equal(attachmentPromptBlock([]), "");
});

test("upload, send and clean up an attachment", async () => {
  const f = await memoryFixture();
  try {
    // One-time link: declared size, quota and the per-file cap are checked first.
    await assert.rejects(createUpload({ sessionId: f.room, userId: f.alice, name: "big.bin", size: 31 * 1024 * 1024, contentType: "" }), (e) => e.status === 413);
    const text = "line\n".repeat(50_000); // 250 KB: far past the old 100 KB / 12,000-character limits
    const { id, token } = await createUpload({ sessionId: f.room, userId: f.alice, name: "server.log", size: Buffer.byteLength(text), contentType: "text/plain" });
    assert.equal(await uploadTokenUser(token), f.alice, "the rate limiter can name the uploader");
    assert.equal(await requestUserId(new Request("http://x/api/attachment-uploads", { method: "PUT", headers: { authorization: `Bearer ${token}` } }), "/api/attachment-uploads"), f.alice);

    await assert.rejects(sendableAttachments([id], f.room, f.alice), /no longer available/, "not sendable before the bytes arrive");
    const uploaded = await receiveUpload(token, body(text));
    assert.deepEqual(uploaded, { id, name: "server.log", size: Buffer.byteLength(text), contentType: "text/plain" });
    assert.equal(await readFile(join(storage, "attachments", id), "utf8"), text, "stored whole, beyond the 10 MB proxy concern");
    await assert.rejects(receiveUpload(token, body(text)), (e) => e.status === 404, "a link works once");

    // Wrong sizes fail and the link is spent; nothing becomes sendable.
    const short = await createUpload({ sessionId: f.room, userId: f.alice, name: "a.txt", size: 10, contentType: "text/plain" });
    await assert.rejects(receiveUpload(short.token, body("123")), /incomplete/);
    const long = await createUpload({ sessionId: f.room, userId: f.alice, name: "b.txt", size: 2, contentType: "text/plain" });
    await assert.rejects(receiveUpload(long.token, body("123")), (e) => e.status === 413);
    const old = await createUpload({ sessionId: f.room, userId: f.alice, name: "c.txt", size: 1, contentType: "text/plain" });
    await f.db.query(`UPDATE chat_attachments SET created_at = now() - interval '16 minutes' WHERE id=$1`, [old.id]);
    await assert.rejects(receiveUpload(old.token, body("1")), (e) => e.status === 404, "links expire");

    // Only the uploader, in the same room, can send it.
    await assert.rejects(sendableAttachments([id], f.room, f.bob), /no longer available/);
    await assert.rejects(sendableAttachments([id], f.other, f.alice), /no longer available/);
    await assert.rejects(sendableAttachments(Array.from({ length: 21 }, () => randomUUID()), f.room, f.alice), /up to 20/);
    assert.equal((await roomAttachment(f.room, id, f.bob)), null, "an unsent upload is private to its uploader");

    const run = await createRun({ sessionId: f.room, startedBy: f.alice, agentId: "codex", baseSha: "a".repeat(40) });
    const turnId = randomUUID();
    await reserveTurn(run.id, f.alice, turnId, 0);
    const rows = await sendableAttachments([id], f.room, f.alice);
    const [file] = attachmentFiles(turnId, rows);
    assert.deepEqual(file, { id, size: Buffer.byteLength(text), sha256: sha(text), contentType: "text/plain", path: `.multicode/attachments/${turnId}/server.log` });
    const message = await appendMessage({ runId: run.id, role: "user", authorUserId: f.alice, body: "Why does this fail?" });
    await bindAttachments([id], turnId, message.id);
    await assert.rejects(bindAttachments([id], randomUUID(), message.id), /already sent/, "sent once");
    const [shown] = await listRunMessages(run.id);
    assert.deepEqual(shown.attachments, [{ id, name: "server.log", size: Buffer.byteLength(text), contentType: "text/plain" }]);
    assert.ok(await roomAttachment(f.room, id, f.bob), "a sent attachment is visible to the room");
    assert.equal(await discardUpload(f.room, id, f.alice), false, "a sent attachment cannot be discarded");

    // Runners that cannot place attachments never claim the turn.
    const job = { turnId, userId: f.alice, controlVersion: 0, sessionId: f.room, runId: run.id, repoId: null, baseSha: "a".repeat(40),
      agentId: "codex", agentPrompt: "x", author: { name: "Alice", email: "a@x" }, userPrompt: "x", attachments: [file] };
    await prepareTurn(job);
    const sql = (text, params) => f.db.query(text, params);
    const device = await deviceFor(sql, f.alice, ["codex"]);
    assert.equal(await claimNextJob({ userId: f.alice, deviceId: device }), null);
    await f.db.query(`UPDATE runner_devices SET supports_attachments = true WHERE id=$1`, [device]);
    assert.equal((await claimNextJob({ userId: f.alice, deviceId: device }))?.job.attachments[0].id, id);

    // Cleanup: an unsent upload expires after a day; its stored file goes with it.
    const stale = await createUpload({ sessionId: f.room, userId: f.alice, name: "stale.txt", size: 1, contentType: "text/plain" });
    await receiveUpload(stale.token, body("s"));
    await f.db.query(`UPDATE chat_attachments SET created_at = now() - interval '25 hours' WHERE id=$1`, [stale.id]);
    await sweepAttachments();
    await assert.rejects(stat(join(storage, "attachments", stale.id)), { code: "ENOENT" });
    assert.ok(await stat(join(storage, "attachments", id)), "sent attachments stay");
    // Deleting the room queues its attachments' files for removal.
    await f.db.query(`DELETE FROM sessions WHERE id=$1`, [f.room]);
    await sweepAttachments();
    await assert.rejects(stat(join(storage, "attachments", id)), { code: "ENOENT" });
  } finally {
    await f.close();
  }
});

test("attachment storage is limited per workspace", async () => {
  const f = await memoryFixture();
  process.env.ATTACHMENT_STORAGE_LIMIT_BYTES = "100";
  try {
    await createUpload({ sessionId: f.room, userId: f.alice, name: "a", size: 60, contentType: "" });
    await assert.rejects(createUpload({ sessionId: f.other, userId: f.bob, name: "b", size: 60, contentType: "" }), (e) => e.status === 507, "rooms of one org share it");
    await createUpload({ sessionId: f.room, userId: f.alice, name: "c", size: 40, contentType: "" });
  } finally {
    delete process.env.ATTACHMENT_STORAGE_LIMIT_BYTES;
    await f.close();
  }
});

test("the runner places attachments in the worktree, outside Git, and verifies them", async (t) => {
  const repo = await mkdtemp(join(tmpdir(), "attachments-repo-"));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: repo, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  await writeFile(join(repo, "a.txt"), "a");
  git("add", "-A"); git("commit", "-q", "-m", "init");
  const work = join(repo, "..", `${repo.split("/").pop()}-work`);
  git("worktree", "add", "-q", work);
  t.after(() => rm(work, { recursive: true, force: true }));

  const turn = randomUUID(), content = "x".repeat(5 * 1024 * 1024);
  const files = [{ id: randomUUID(), path: `.multicode/attachments/${turn}/big.log`, size: content.length, sha256: sha(content) }];
  let downloads = 0;
  const fetchAttachment = async () => { downloads += 1; return new Blob([content]).stream(); };
  assert.equal(await placeAttachments(work, turn, files, fetchAttachment), 1);
  assert.equal(await readFile(join(work, files[0].path), "utf8"), content);
  assert.equal(execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: work, encoding: "utf8" }), "", "never committed or seen as unfinished edits");
  await placeAttachments(work, turn, files, fetchAttachment);
  assert.equal(downloads, 1, "an intact file is not downloaded again");

  await assert.rejects(placeAttachments(work, randomUUID(), [{ ...files[0], path: `.multicode/attachments/${randomUUID()}/bad.log`, sha256: "0".repeat(64) }], fetchAttachment), /did not match/);
  for (const path of ["../escape.txt", ".multicode/attachments/../../x", `.multicode/attachments/${turn}/../x`, "/etc/passwd", `.multicode/attachments/${turn}/a/b`])
    assert.throws(() => attachmentDestination(work, path), /Refusing/, path);

  // Other turns' folders are pruned after a week; this turn's stay.
  const oldTurn = randomUUID();
  await mkdir(join(work, ".multicode/attachments", oldTurn), { recursive: true });
  const weekAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  await utimes(join(work, ".multicode/attachments", oldTurn), weekAgo, weekAgo);
  await placeAttachments(work, turn, files, fetchAttachment);
  await assert.rejects(stat(join(work, ".multicode/attachments", oldTurn)), { code: "ENOENT" });
});
