// Attachments through the production server: a signed-in request for a
// one-time link, a 15 MB body streamed past the Next proxy (which would
// truncate it at 10 MB), and downloads gated by room access and sending.
import { clerkFixture, clerkCookie } from "./helpers/clerk-fixture.mjs";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import nextEnv from "@next/env";
import { memoryFixture } from "./helpers/memory-fixture.mjs";
import { createRun, appendMessage } from "../app/lib/ai/runs.ts";
import { reserveTurn } from "../app/lib/ai/turns.ts";
import { bindAttachments } from "../app/lib/ai/attachments.ts";

nextEnv.loadEnvConfig(process.cwd());
const databaseUrl = process.env.DATABASE_URL;
const storage = await mkdtemp(join(tmpdir(), "attachments-http-"));
const f = await memoryFixture({ postgres: true });
const clerk = await clerkFixture();
let server, output = "";
try {
  const cookies = {};
  for (const [name, id] of [["alice", f.alice], ["bob", f.bob], ["outsider", f.outsider]]) cookies[name] = clerkCookie(await clerk.link(f.db, id));
  const schema = (await f.first("SELECT current_schema() AS name")).name;
  const url = new URL(databaseUrl);
  url.searchParams.set("options", `-c search_path=${schema},public`);
  const port = process.env.ATTACHMENTS_TEST_PORT ?? "3197", base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1", "-p", port], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...clerk.env, DATABASE_URL: url.toString(), REDIS_URL: "", LOCAL_RUNNERS: "0", WEB_CONCURRENCY: "1",
      API_TRUST_PROXY: "0", STORAGE_PROVIDER: "local", STORAGE_LOCAL_DIR: storage },
  });
  server.stdout.on("data", (data) => { output += data; });
  server.stderr.on("data", (data) => { output += data; });
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    try { ready = (await fetch(base + "/health/ready", { signal: AbortSignal.timeout(1000) })).ok; } catch { /* starting */ }
    if (!ready) await delay(100);
  }
  assert.ok(ready, "production server is ready");

  const room = `${base}/api/sessions/${f.room}/attachments`;
  const ticket = async (cookie, file) => fetch(room, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(file) });
  const put = (token, bytes) => fetch(`${base}/api/attachment-uploads`, { method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" }, body: bytes, duplex: "half" });

  assert.equal((await ticket("", { name: "x", size: 1 })).status, 401, "signed out");
  assert.equal((await ticket(cookies.outsider, { name: "x", size: 1 })).status, 403, "not in the room");

  // 15 MB: more than Next proxy's 10 MB buffer, which would cut it short.
  const big = Buffer.alloc(15 * 1024 * 1024);
  for (let i = 0; i < big.length; i += 4096) big.writeUInt32LE(i, i);
  const issued = await (await ticket(cookies.alice, { name: "trace.bin", size: big.length, contentType: "application/octet-stream" })).json();
  assert.equal(issued.uploadUrl, "/api/attachment-uploads");
  assert.equal((await put("not-a-token", Buffer.from("x"))).status, 404);
  const uploaded = await put(issued.token, big);
  assert.equal(uploaded.status, 200, await uploaded.clone().text());
  assert.deepEqual(await uploaded.json(), { id: issued.id, name: "trace.bin", size: big.length, contentType: "application/octet-stream" });
  assert.equal((await put(issued.token, big)).status, 404, "a link works once");

  const download = (cookie, id = issued.id) => fetch(`${room}/${id}`, { headers: { cookie } });
  const mine = await download(cookies.alice);
  assert.equal(mine.status, 200);
  assert.equal(mine.headers.get("content-type"), "application/octet-stream");
  assert.match(mine.headers.get("content-disposition"), /^attachment; filename\*=UTF-8''trace\.bin$/);
  assert.equal(mine.headers.get("x-content-type-options"), "nosniff");
  const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
  assert.equal(sha(Buffer.from(await mine.arrayBuffer())), sha(big), "the whole file arrived intact");
  assert.equal((await download(cookies.bob)).status, 404, "unsent uploads are private to the uploader");

  // Once sent, the room can download it; outsiders still cannot.
  const run = await createRun({ sessionId: f.room, startedBy: f.alice, agentId: "codex", baseSha: "a".repeat(40) });
  const turnId = randomUUID();
  await reserveTurn(run.id, f.alice, turnId, 0);
  const message = await appendMessage({ runId: run.id, role: "user", authorUserId: f.alice, body: "look" });
  await bindAttachments([issued.id], turnId, message.id);
  assert.equal((await download(cookies.bob)).status, 200, "a sent attachment is visible to the room");
  assert.equal((await download(cookies.outsider)).status, 403);

  // Raster images display inline; anything that could run as a page never does.
  const png = await (await ticket(cookies.alice, { name: "shot.png", size: 4, contentType: "image/png" })).json();
  assert.equal((await put(png.token, Buffer.from([0x89, 0x50, 0x4e, 0x47]))).status, 200);
  const image = await download(cookies.alice, png.id);
  assert.equal(image.headers.get("content-type"), "image/png");
  assert.match(image.headers.get("content-disposition"), /^inline;/);
  const html = await (await ticket(cookies.alice, { name: "page.html", size: 5, contentType: "text/html" })).json();
  assert.equal((await put(html.token, Buffer.from("<b>x<"))).status, 200);
  const page = await download(cookies.alice, html.id);
  assert.equal(page.headers.get("content-type"), "application/octet-stream");
  assert.match(page.headers.get("content-security-policy"), /sandbox/);
  // A body larger than declared is refused, and the server keeps serving.
  const short = await (await ticket(cookies.alice, { name: "short.txt", size: 2 })).json();
  assert.equal((await put(short.token, Buffer.alloc(1024 * 1024))).status, 413);
  assert.equal((await download(cookies.alice, png.id)).status, 200, "still serving after a refused upload");
  console.log("PASS: attachment links, 15 MB streamed past the proxy intact, single-use tokens, room-gated downloads and safe content types.");
} catch (error) {
  console.error(output.slice(-5000));
  throw error;
} finally {
  if (server && server.exitCode === null) { server.kill(); await once(server, "exit"); }
  await clerk.close();
  await f.close();
  await rm(storage, { recursive: true, force: true });
}
