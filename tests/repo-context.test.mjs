import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { vector } from "@electric-sql/pglite-pgvector";
import { migrate } from "../db/migrate.mjs";
import { chunkSource, CHUNK_CHARS } from "../app/lib/knowledge/repo-chunks.ts";
import { ensureRepoContext, indexNextRepoJob, indexedRepoSha, embedPendingRepoChunks, recallRepoContext, forgetRepoIndex } from "../app/lib/knowledge/repo-context.ts";
import { embedRepoTexts, repoEmbeddingConfig } from "../app/lib/knowledge/repo-embeddings.ts";
import { repoSnapshotPaths, repoSnapshotText } from "../app/lib/session/repo.ts";
import { buildKnowledgeContext } from "../app/lib/knowledge/index.ts";

const root = await mkdtemp(join(tmpdir(), "repo-context-"));
const db = await PGlite.create({ extensions: { citext, vector } });
globalThis.__maPool = {
  query: (sql, params) => db.query(sql, params),
  connect: async () => ({ query: (sql, params) => db.query(sql, params), release() {} }),
};
process.env.MULTIPLAYER_AI_DATA = root;
process.env.AGENT_WORKER = "1";
process.env.REDIS_URL = "redis://unused";
delete process.env.MNEMOSYNE_URL;
process.env.REPO_EMBEDDING_URL = "";
process.env.REPO_EMBEDDING_MODEL = "";
const ref = "contexttestx";
const other = "contextothrx";
const work = join(root, "source");
const bare = join(root, "repos", `${ref}.git`);
const git = (args, cwd = work) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).trim();
const commit = (message) => {
  git(["add", "-A"]);
  git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "-m", message]);
  git(["push", "origin", `HEAD:refs/heads/session/${ref}`]);
  return git(["rev-parse", "HEAD"]);
};
const first = async (sql, params) => (await db.query(sql, params)).rows[0];
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`  ok ${name}`); };
let sha1, sha2;
const realFetch = globalThis.fetch;
try {
  await migrate(db);
  await mkdir(join(root, "repos"));
  await mkdir(work);
  git(["init", "--bare", bare], root);
  git(["init", "-b", "main"]);
  git(["remote", "add", "origin", bare]);
  for (let i = 0; i < 95; i++) await writeFile(join(work, `file${i}.ts`), `export function leaf${i}() { return ${i}; }\n`);
  await writeFile(join(work, "auth.ts"), "export function verifyToken() {\n  return 'credential validation';\n}\n\nexport function untouched() {\n  return true;\n}\n");
  await writeFile(join(work, "remove.ts"), "export function obsoleteSymbol() {}\n");
  await writeFile(join(work, "odd\nname.ts"), "export const strangeName = () => true;\n");
  sha1 = commit("first");
  await test("free local defaults and custom models use separate embedding configurations", async () => {
    const names = ["REPO_EMBEDDING_URL", "REPO_EMBEDDING_MODEL", "REPO_EMBEDDING_DIMENSIONS", "REPO_EMBEDDING_QUERY_PREFIX", "REPO_EMBEDDING_DOCUMENT_PREFIX"];
    const saved = new Map(names.map((name) => [name, process.env[name]]));
    try {
      for (const name of names) delete process.env[name];
      const local = repoEmbeddingConfig();
      assert.equal(local.model, "nomic-embed-text:v1.5");
      assert.equal(local.dimensions, 768);
      assert.equal(local.url, "http://localhost:11435/v1/embeddings");
      assert.equal(local.documentPrefix, "search_document: ");
      assert.equal(local.queryPrefix, "search_query: ");
      process.env.REPO_EMBEDDING_MODEL = "custom-model";
      process.env.REPO_EMBEDDING_URL = "https://custom.example/embeddings";
      process.env.REPO_EMBEDDING_DIMENSIONS = "1024";
      const custom = repoEmbeddingConfig();
      assert.equal(custom.queryPrefix, "");
      assert.equal(custom.dimensions, 1024);
      assert.notEqual(custom.key, local.key);
      process.env.REPO_EMBEDDING_QUERY_PREFIX = "query: ";
      assert.notEqual(repoEmbeddingConfig().key, custom.key);
      process.env.REPO_EMBEDDING_URL = "";
      assert.equal(repoEmbeddingConfig(), null);
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
    }
  });
  await test("AST chunks retain complete source, symbol names, and exact line ranges", async () => {
    const text = "import x from 'x';\nexport class Service {\n  verifyToken() {\n    return x;\n  }\n}\n";
    const chunks = chunkSource("a.ts", text);
    assert.ok(chunks.some((c) => c.symbol === "Service.verifyToken"));
    for (const c of chunks) assert.equal(c.content, text.split("\n").slice(c.startLine - 1, c.endLine).join("\n"));
    assert.ok(chunks.some((c) => c.content.includes("import x")));
    for (const [path, body, name] of [["a.py", "def hello():\n  return 1\n", "hello"], ["a.go", "package a\nfunc Hello() {}", "Hello"], ["a.rs", "pub fn hello() {}", "hello"]]) {
      assert.ok(chunkSource(path, body).some((c) => c.symbol === name));
    }
    const long = chunkSource("a.md", "z".repeat(9000));
    assert.equal(long.map((c) => c.content).join(""), "z".repeat(9000));
    assert.ok(long.every((c) => c.content.length <= CHUNK_CHARS));
  });
  await test("immutable snapshot reads preserve unusual paths and do not follow HEAD", async () => {
    assert.ok((await repoSnapshotPaths(ref, sha1)).includes("odd\nname.ts"));
    assert.match(await repoSnapshotText(ref, sha1, "auth.ts"), /verifyToken/);
  });
  await test("index all eligible files with no 80-file or 30-chunk cap", async () => {
    await ensureRepoContext(ref, sha1);
    assert.equal(await indexedRepoSha(ref), null);
    assert.equal(await indexNextRepoJob(ref), true);
    assert.equal(await indexedRepoSha(ref), sha1);
    assert.equal((await first("SELECT count(DISTINCT path)::int AS n FROM repo_context_chunks WHERE repo_ref=$1", [ref])).n, 98);
    assert.ok((await first("SELECT count(*)::int AS n FROM repo_context_chunks")).n > 30);
    const hits = await recallRepoContext([ref], "why does verifyToken fail?");
    assert.ok(hits[0].content.includes("auth.ts:1-3 (verifyToken)"));
    assert.ok(hits[0].content.includes(sha1));
  });
  await test("repo recall works through the knowledge layer without mnemosyne", async () => {
    const context = await buildKnowledgeContext({ projectId: null, userId: "unused", currentSessionId: ref, prompt: "fix verifyToken" });
    assert.ok(context.repoText?.includes("verifyToken"));
    assert.equal(context.memoryText, null);
  });
  let embeddedTexts = [];
  await test("pgvector stores embeddings and finds semantic-only matches within the requested ref", async () => {
    process.env.REPO_EMBEDDING_URL = "https://embedding.test/v1/embeddings";
    process.env.REPO_EMBEDDING_MODEL = "test-model";
    process.env.REPO_EMBEDDING_DIMENSIONS = "3";
    globalThis.fetch = async (_url, options) => {
      const { input } = JSON.parse(options.body);
      embeddedTexts.push(...input);
      return Response.json({ data: input.map((text, index) => ({ index, embedding: text.includes("verifyToken") || text.includes("sesame") ? [1, 0, 0] : [0, 1, 0] })).reverse() });
    };
    while (await embedPendingRepoChunks(ref)) { /* drain */ }
    assert.equal((await first("SELECT count(*)::int AS n FROM repo_context_chunks WHERE embedding IS NULL")).n, 0);
    await db.query("INSERT INTO repo_context_index(repo_ref,head_sha,index_version) VALUES ($1,$2,1)", [other, sha1]);
    await db.query(`INSERT INTO repo_context_chunks(repo_ref,chunk_id,chunk_index,path,start_line,end_line,symbol_name,content,search_text,embedding,embedding_key)
      SELECT $1,chunk_id,chunk_index,path,start_line,end_line,symbol_name,content,search_text,embedding,embedding_key FROM repo_context_chunks WHERE repo_ref=$2 LIMIT 1`, [other, ref]);
    const hits = await recallRepoContext([ref], "sesame");
    assert.ok(hits[0].content.includes("verifyToken"));
    assert.ok(hits.every((hit) => !hit.content.includes(other)));
    assert.deepEqual(await recallRepoContext(["absentrefxxx"], "sesame"), []);
  });
  await test("diff indexing removes deleted/renamed files and reuses unchanged symbol vectors", async () => {
    const stable = await first("SELECT chunk_id,embedding::text FROM repo_context_chunks WHERE repo_ref=$1 AND symbol_name='untouched'", [ref]);
    await writeFile(join(work, "auth.ts"), "// shifted lines\nexport function verifyToken() {\n  return 'new credential validation';\n}\n\nexport function untouched() {\n  return true;\n}\n");
    await rm(join(work, "remove.ts"));
    await rename(join(work, "file94.ts"), join(work, "renamed.ts"));
    sha2 = commit("change");
    await ensureRepoContext(ref, sha2);
    assert.equal(await indexedRepoSha(ref), sha1);
    await indexNextRepoJob(ref);
    assert.equal(await indexedRepoSha(ref), sha2);
    assert.equal((await first("SELECT count(*)::int AS n FROM repo_context_chunks WHERE repo_ref=$1 AND path IN ('remove.ts','file94.ts')", [ref])).n, 0);
    const current = await first("SELECT chunk_id,embedding::text,start_line FROM repo_context_chunks WHERE repo_ref=$1 AND symbol_name='untouched'", [ref]);
    assert.equal(current.chunk_id, stable.chunk_id);
    assert.equal(current.embedding, stable.embedding);
    assert.equal(current.start_line, 6);
    embeddedTexts = [];
    while (await embedPendingRepoChunks(ref)) { /* drain */ }
    assert.ok(!embeddedTexts.some((text) => text.includes("untouched")));
    assert.ok(!embeddedTexts.some((text) => text.includes("leaf0")));
    assert.ok(embeddedTexts.some((text) => text.includes("new credential")));
    assert.match(await repoSnapshotText(ref, sha1, "auth.ts"), /return 'credential validation'/);
  });
  await test("failed builds preserve the published snapshot and leave retryable jobs", async () => {
    await ensureRepoContext(ref, "f".repeat(40));
    await assert.rejects(indexNextRepoJob(ref));
    assert.equal(await indexedRepoSha(ref), sha2);
    assert.ok((await first("SELECT last_error FROM repo_context_jobs WHERE repo_ref=$1", [ref])).last_error);
    assert.ok((await recallRepoContext([ref], "verifyToken"))[0].content.includes(sha2));
    await db.query("DELETE FROM repo_context_jobs WHERE repo_ref=$1", [ref]);
  });
  await test("embedding failures and model changes preserve keyword search", async () => {
    globalThis.fetch = async () => { throw new Error("endpoint offline"); };
    assert.ok((await recallRepoContext([ref], "verifyToken"))[0].content.includes("verifyToken"));
    process.env.REPO_EMBEDDING_MODEL = "different-model";
    await assert.rejects(embedPendingRepoChunks(ref), /offline/);
    assert.deepEqual(await recallRepoContext([ref], "sesame"), []);
    assert.ok((await recallRepoContext([ref], "verifyToken"))[0].content.includes("verifyToken"));
    globalThis.fetch = async () => Response.json({ data: [{ index: 0, embedding: [1, 2] }] });
    await assert.rejects(embedRepoTexts(repoEmbeddingConfig(), ["x"]), /Invalid repo embedding/);
  });
  await test("no-op approvals do not enqueue work and a newer approval replaces pending work", async () => {
    await ensureRepoContext(ref, sha2);
    assert.equal(await indexNextRepoJob(ref), false);
    await ensureRepoContext(ref, sha1);
    await ensureRepoContext(ref, sha2);
    assert.equal((await first("SELECT head_sha FROM repo_context_jobs WHERE repo_ref=$1", [ref])).head_sha, sha2);
    await indexNextRepoJob(ref);
    assert.equal(await indexedRepoSha(ref), sha2);
  });
  await test("a failure after chunk deletion rolls back the whole snapshot and can retry", async () => {
    await writeFile(join(work, "auth.ts"), "export function replacementSymbol() { return 3; }\n");
    const next = commit("rollback fixture");
    await ensureRepoContext(ref, next);
    const pool = globalThis.__maPool;
    const originalConnect = pool.connect;
    pool.connect = async () => ({
      query(sql, params) {
        if (sql.includes("INSERT INTO repo_context_chunks")) throw new Error("injected write failure");
        return db.query(sql, params);
      },
      release() {},
    });
    try { await assert.rejects(indexNextRepoJob(ref), /injected write failure/); }
    finally { pool.connect = originalConnect; }
    assert.equal(await indexedRepoSha(ref), sha2);
    assert.ok((await recallRepoContext([ref], "verifyToken"))[0].content.includes("verifyToken"));
    await db.query("UPDATE repo_context_jobs SET retry_at=now() WHERE repo_ref=$1", [ref]);
    await indexNextRepoJob(ref);
    assert.equal(await indexedRepoSha(ref), next);
    sha2 = next;
  });
  await test("oversized/binary skips are recorded and cleared when files become indexable", async () => {
    await writeFile(join(work, "huge.ts"), "x".repeat(2 * 1024 * 1024 + 1));
    await writeFile(join(work, "binary.ts"), Buffer.from([65, 0, 66]));
    const skippedSha = commit("skipped files");
    await ensureRepoContext(ref, skippedSha);
    await indexNextRepoJob(ref);
    assert.equal((await first("SELECT skipped_files FROM repo_context_index WHERE repo_ref=$1", [ref])).skipped_files, 2);
    await writeFile(join(work, "huge.ts"), "export function nowSmall() {}\n");
    await rm(join(work, "binary.ts"));
    const fixedSha = commit("fixed skipped files");
    await ensureRepoContext(ref, fixedSha);
    await indexNextRepoJob(ref);
    assert.equal((await first("SELECT skipped_files FROM repo_context_index WHERE repo_ref=$1", [ref])).skipped_files, 0);
    assert.ok((await recallRepoContext([ref], "nowSmall"))[0].content.includes("nowSmall"));
  });
  await test("empty snapshots clear stale chunks and forgetting removes all stored context", async () => {
    git(["rm", "-r", "."]);
    const emptySha = commit("empty");
    await ensureRepoContext(ref, emptySha);
    await indexNextRepoJob(ref);
    assert.equal(await indexedRepoSha(ref), emptySha);
    assert.deepEqual(await recallRepoContext([ref], "verifyToken"), []);
    await forgetRepoIndex(ref);
    assert.equal(await indexedRepoSha(ref), null);
    assert.equal((await first("SELECT count(*)::int AS n FROM repo_context_chunks WHERE repo_ref=$1", [ref])).n, 0);
  });
  console.log(`${passed} repo context tests passed`);
} finally {
  globalThis.fetch = realFetch;
  await db.close();
  await rm(root, { recursive: true, force: true });
}
