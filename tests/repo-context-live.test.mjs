/** Opt-in smoke test against the configured Postgres and embedding endpoint.
 * Uses an isolated schema + temporary Git repo; never indexes user source. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nextEnv from "@next/env";
import pg from "pg";
import { ensureRepoContext, indexNextRepoJob, embedPendingRepoChunks, recallRepoContext } from "../app/lib/knowledge/repo-context.ts";
import { embedRepoTexts, repoEmbeddingConfig } from "../app/lib/knowledge/repo-embeddings.ts";

nextEnv.loadEnvConfig(process.cwd(), true);
assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required");
const config = repoEmbeddingConfig();
assert.ok(config, "An embedding endpoint/model must be configured");
const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
await admin.connect();
const schema = `repo_smoke_${randomBytes(8).toString("hex")}`;
const root = await mkdtemp(join(tmpdir(), "repo-context-live-"));
const ref = "livesmokexxx";
const work = join(root, "source");
const bare = join(root, "repos", `${ref}.git`);
let testPool;
const first = async (sql, params) => (await testPool.query(sql, params)).rows[0];
const git = (args, cwd = work) => execFileSync("git", args, {
  cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
}).trim();
const commit = (message) => {
  git(["add", "-A"]);
  git(["-c", "user.name=Smoke test", "-c", "user.email=smoke@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", message]);
  git(["push", "origin", `HEAD:refs/heads/session/${ref}`]);
  return git(["rev-parse", "HEAD"]);
};
try {
  const extension = (await admin.query("SELECT extversion FROM pg_extension WHERE extname='vector'")).rows[0];
  assert.ok(extension, "Apply migration 029 first");
  await admin.query(`CREATE SCHEMA ${schema}`);
  for (const table of ["repo_context_index", "repo_context_chunks", "repo_context_jobs", "repo_context_skipped_files"]) {
    await admin.query(`CREATE TABLE ${schema}.${table} (LIKE public.${table} INCLUDING ALL)`);
  }
  testPool = new pg.Pool({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${schema},public`, max: 3 });
  globalThis.__maPool = testPool;
  process.env.MULTIPLAYER_AI_DATA = root;
  // Enqueue only; this test explicitly drives each worker step.
  process.env.REPO_INDEX_INLINE = "0";
  await mkdir(join(root, "repos"));
  await mkdir(work);
  git(["init", "--bare", bare], root);
  git(["init", "-b", "main"]);
  git(["remote", "add", "origin", bare]);
  await writeFile(join(work, "auth.ts"), [
    "export function verifyToken(token: string) {",
    "  // Authenticate credentials and authorize the user's access to protected resources.",
    "  return token === 'valid-credential';",
    "}",
  ].join("\n"));
  await writeFile(join(work, "garden.ts"), [
    "export function waterPlants(liters: number) {",
    "  // Irrigate flowers and vegetables with water to keep the garden healthy.",
    "  return liters * 2;",
    "}",
  ].join("\n"));
  const sha = commit("initial source");
  const began = performance.now();
  const [probe] = await embedRepoTexts(config, ["Check local model readiness"], 120_000, "query");
  assert.equal(probe.length, config.dimensions);
  console.log(`Embedding endpoint ready: ${config.model}, ${probe.length} dimensions (${Math.round(performance.now() - began)} ms)`);
  await ensureRepoContext(ref, sha);
  assert.equal(await indexNextRepoJob(ref), true);
  while (await embedPendingRepoChunks(ref)) { /* drain */ }
  const count = await first("SELECT count(*)::int AS chunks, count(embedding)::int AS vectors FROM repo_context_chunks");
  assert.equal(count.chunks, 2);
  assert.equal(count.vectors, 2);
  const lexical = await recallRepoContext([ref], "verifyToken");
  assert.match(lexical[0].content, /auth\.ts:1-4 \(verifyToken\)/);
  assert.ok(lexical[0].content.includes(sha));

  // All words differ from the source, forcing a semantic-only retrieval.
  const prompt = "identity permission security";
  const keywordCount = await first("SELECT count(*)::int AS n FROM repo_context_chunks WHERE search_vector @@ to_tsquery('simple', 'identity | permission | security')");
  assert.equal(keywordCount.n, 0);
  const semantic = await recallRepoContext([ref], prompt);
  assert.match(semantic[0]?.content ?? "", /auth\.ts/);
  const stable = await first("SELECT chunk_id, embedding::text FROM repo_context_chunks WHERE path='garden.ts'");
  await writeFile(join(work, "auth.ts"), "export function refreshSession() { return 'renew authentication session'; }\n");
  const nextSha = commit("replace auth symbol");
  await ensureRepoContext(ref, nextSha);
  await indexNextRepoJob(ref);
  assert.equal((await first("SELECT count(*)::int AS n FROM repo_context_chunks WHERE symbol_name='verifyToken'")).n, 0);
  assert.deepEqual(await first("SELECT chunk_id, embedding::text FROM repo_context_chunks WHERE path='garden.ts'"), stable);
  while (await embedPendingRepoChunks(ref)) { /* drain */ }
  const refreshed = await recallRepoContext([ref], "refreshSession");
  assert.ok(refreshed[0].content.includes(nextSha));
  console.log(`Live pgvector ${extension.extversion}: keyword + semantic retrieval, commit citations, and incremental embedding reuse passed`);
} finally {
  if (testPool) await testPool.end();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
  await rm(root, { recursive: true, force: true });
}
