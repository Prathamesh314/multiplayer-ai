import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { objectStore, storageConfig } from "../app/lib/storage/object-store.ts";

async function bytes(stream) { const chunks = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks); }
test("disk is the default, including when cloud settings exist; invalid explicit providers fail", () => {
  assert.equal(storageConfig({}).provider, "local");
  assert.equal(storageConfig({ STORAGE_BUCKET: "must-not-upload", STORAGE_ENDPOINT: "invalid" }).provider, "local");
  assert.throws(() => storageConfig({ STORAGE_PROVIDER: "typo" }), /Unsupported/);
  assert.throws(() => storageConfig({ STORAGE_PROVIDER: "s3" }), /STORAGE_BUCKET/);
  assert.throws(() => storageConfig({ STORAGE_PROVIDER: "s3", STORAGE_BUCKET: "test", STORAGE_ACCESS_KEY_ID: "incomplete" }), /both/);
  assert.throws(() => storageConfig({ STORAGE_PREFIX: "../escape" }), /PREFIX/);
});
test("local objects survive a new store instance, preserve exact bytes, and cannot escape their directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "storage-local-"));
  try {
    const config = storageConfig({ STORAGE_LOCAL_DIR: directory, STORAGE_PREFIX: "test" });
    const store = objectStore(config), payload = Buffer.from([0, 255, 12, 66]);
    await store.put("activity/fixture/data.gz", payload);
    assert.deepEqual(await readFile(join(directory,"test/activity/fixture/data.gz")), payload);
    assert.deepEqual(await bytes(await objectStore(config).read("activity/fixture/data.gz")), payload);
    const source = join(directory,"source.bundle"); await writeFile(source, payload);
    await store.putFile("git/fixture/data.bundle", source);
    assert.deepEqual(await bytes(await store.read("git/fixture/data.bundle")), payload);
    assert.equal((await stat(join(directory,"test/git/fixture/data.bundle"))).mode & 0o777, 0o600);
    assert.throws(() => store.put("../outside", payload), /Invalid/);
    assert.throws(() => store.remove("git/../../outside"), /Invalid/);
    await store.remove("activity/fixture/data.gz");
    await assert.rejects(bytes(await store.read("activity/fixture/data.gz")), /ENOENT/);
    await assert.rejects(store.putFile("git/fixture/missing.bundle", "missing-input-file"), /ENOENT/);
  } finally { await rm(directory,{recursive:true,force:true}); }
});
test("S3-compatible adapter uses configured endpoint, credentials, prefix and streamed archive operations", async () => {
  const objects = new Map(), seen = [];
  const server = createServer(async (request, response) => {
    const key = new URL(request.url,"http://localhost").pathname;
    seen.push({ key, authorization: request.headers.authorization });
    if (request.method === "PUT") { objects.set(key,await bytes(request)); response.writeHead(200,{ETag:'"test-etag"'}).end(); }
    else if (request.method === "GET" && objects.has(key)) { const body=objects.get(key); response.writeHead(200,{"content-length":body.length}).end(body); }
    else if (request.method === "DELETE") { objects.delete(key); response.writeHead(204).end(); }
    else response.writeHead(404,{"content-type":"application/xml"}).end("<Error><Code>NoSuchKey</Code></Error>");
  });
  const directory = await mkdtemp(join(tmpdir(),"storage-cloud-contract-"));
  server.listen(0,"127.0.0.1");
  try {
    await once(server,"listening");
    const config = storageConfig({ STORAGE_PROVIDER:"s3", STORAGE_BUCKET:"test-bucket", STORAGE_REGION:"auto",
      STORAGE_ENDPOINT:`http://127.0.0.1:${server.address().port}`, STORAGE_PATH_STYLE:"1", STORAGE_PREFIX:"team",
      STORAGE_ACCESS_KEY_ID:"test-only-key", STORAGE_SECRET_ACCESS_KEY:"test-only-secret" });
    const store = objectStore(config), payload=Buffer.from("exact compressed object bytes\0");
    await store.put("activity/fixture/data.gz",payload);
    assert.deepEqual(await bytes(await objectStore(config).read("activity/fixture/data.gz")),payload);
    const source=join(directory,"source.bundle"); await writeFile(source,payload);
    await store.putFile("git/fixture/data.bundle",source);
    assert.deepEqual(await bytes(await store.read("git/fixture/data.bundle")),payload);
    await store.remove("activity/fixture/data.gz"); await store.remove("git/fixture/data.bundle");
    assert.equal(objects.size,0);
    assert.ok(seen.every(item=>item.key.startsWith("/test-bucket/team/")));
    assert.ok(seen.every(item=>item.authorization?.includes("test-only-key/") && item.authorization.includes("/auto/s3/")));
  } finally { await new Promise(resolve=>server.close(resolve)); await rm(directory,{recursive:true,force:true}); }
});
