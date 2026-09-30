import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, rename, writeFile, mkdtemp } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { query, queryOne } from "../db/client";
import { repoLock } from "../session/lock";
import { dataRoot } from "../session/paths";
import { objectGit, objectText } from "../git/objects";
import { storeFileObject, readFileObject, removeFileObject } from "./blobs";
const held = new AsyncLocalStorage<Map<string, { active: boolean }>>();
const enabled = () => process.env.STORAGE_COLD_GIT === "1";
function repositoryKey(path: string) {
  const key = relative(dataRoot(), resolve(path)).replaceAll("\\", "/");
  if (!/^(repos|projects)\/[a-zA-Z0-9_-]+\.git$/.test(key)) throw new Error("Invalid repository cache path.");
  return key;
}
async function hashFile(path: string) { const hash = createHash("sha256"); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest("hex"); }
async function present(path: string) { return stat(path).then(() => true, () => false); }
function pins(key: string) { return join(dataRoot(), "git-pins", createHash("sha256").update(key).digest("hex")); }

/** Pins span whole repository operations, including multi-command writes. Never evict a pinned repo. */
export async function acquireStoredRepo(path: string): Promise<() => Promise<void>> {
  if (!enabled()) return async () => {};
  const key = repositoryKey(path), lock = await repoLock();
  const pin = join(pins(key), randomUUID());
  await lock.withLock(`git-storage:${key}`, async () => {
    if (!await present(path)) {
      const archive = await queryOne<{ object_key: string; content_hash: string }>(`SELECT object_key, content_hash FROM git_archives WHERE repository_key = $1`, [key]);
      if (archive) {
        await mkdir(dirname(path), { recursive: true });
        const scratch = await mkdtemp(join(dirname(path), ".hydrate-"));
        try {
          const bundle = join(scratch, "repository.bundle");
          await pipeline(await readFileObject(archive.object_key), createWriteStream(bundle, { mode: 0o600 }));
          if (await hashFile(bundle) !== archive.content_hash) throw new Error("Archived repository checksum mismatch.");
          const bare = join(scratch, "repository.git");
          await objectGit(scratch, ["init", "--bare", bare]);
          await objectGit(bare, ["fetch", bundle, "+refs/*:refs/*"]);
          await objectGit(bare, ["symbolic-ref", "HEAD", "refs/heads/main"]);
          await rename(bare, path);
        } finally { await rm(scratch, { recursive: true, force: true }); }
      }
    }
    await mkdir(pins(key), { recursive: true });
    await writeFile(pin, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
    if (await present(path)) await writeFile(join(path, "multiplayer-last-used"), String(Date.now()));
  });
  return async () => { await rm(pin, { force: true }); scheduleTrim(); };
}
export async function withStoredRepo<T>(path: string, action: () => Promise<T>): Promise<T> {
  if (!enabled()) return action();
  const key = repositoryKey(path);
  if (held.getStore()?.get(key)?.active) return action();
  const release = await acquireStoredRepo(path);
  const state = { active: true };
  try { return await held.run(new Map([...(held.getStore() ?? []), [key, state]]), action); }
  finally { state.active = false; await release(); }
}

/** Upload + verify before eviction. No bare directory is removed on an upload failure. */
export async function archiveStoredRepo(path: string): Promise<boolean> {
  if (!enabled()) throw new Error("Set STORAGE_COLD_GIT=1 before archiving repositories.");
  const key = repositoryKey(path), lock = await repoLock();
  return lock.withLock(`git-storage:${key}`, async () => {
    if ((await readdir(pins(key)).catch(() => [])).length || !await present(path)) return false;
    if (await present(join(path, "import.index"))) return false;
    // Never archive a repository with outstanding temporary indexes or operations.
    if ((await readdir(path)).some(name => name.endsWith(".lock") || name.startsWith("tmp-index-") || name.startsWith(".merge-"))) return false;
    if (!(await objectText(path, ["for-each-ref", "--format=%(refname)"]))) return false;
    const scratch = await mkdtemp(join(dataRoot(), ".archive-"));
    try {
      const bundle = join(scratch, "repository.bundle");
      await objectGit(path, ["bundle", "create", bundle, "--all"]);
      await objectGit(path, ["bundle", "verify", bundle]);
      const hash = await hashFile(bundle), bytes = (await stat(bundle)).size;
      const objectKey = `git/${createHash("sha256").update(key).digest("hex")}/${hash}.bundle`;
      await storeFileObject(objectKey, bundle);
      // Verify the remotely stored bytes before treating them as the only copy.
      const verify = createHash("sha256"); for await (const chunk of await readFileObject(objectKey)) verify.update(chunk);
      if (verify.digest("hex") !== hash) throw new Error("Repository archive verification failed.");
      const previous = await queryOne<{ object_key: string }>(`SELECT object_key FROM git_archives WHERE repository_key=$1`, [key]);
      await query(`INSERT INTO git_archives(repository_key,object_key,content_hash,bytes) VALUES ($1,$2,$3,$4)
        ON CONFLICT(repository_key) DO UPDATE SET object_key=EXCLUDED.object_key, content_hash=EXCLUDED.content_hash, bytes=EXCLUDED.bytes, updated_at=now()`, [key, objectKey, hash, bytes]);
      // Every live Git endpoint and repository helper pins this directory.
      await rename(path, join(scratch, "evicted.git"));
      if (previous && previous.object_key !== objectKey) await removeFileObject(previous.object_key).catch(error => console.warn("Old Git archive cleanup deferred", error.message));
      return true;
    } finally { await rm(scratch, { recursive: true, force: true }); }
  });
}

async function directoryBytes(path: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(child);
    else if (entry.isFile()) total += (await stat(child).catch(() => ({ size: 0 }))).size;
  }
  return total;
}
let trimming: Promise<{ bytes: number; archived: string[] }> | null = null;
let lastTrim = 0;
function scheduleTrim() {
  if (!process.env.STORAGE_GIT_CACHE_BYTES || trimming || Date.now() - lastTrim < 30_000) return;
  lastTrim = Date.now();
  void trimGitCache().catch(error => console.error("Git cache trimming deferred:", error.message));
}
/** Target budget: active/importing repositories stay pinned even when over budget. */
export function trimGitCache(): Promise<{ bytes: number; archived: string[] }> {
  if (trimming) return trimming;
  trimming = (async () => {
    const target = Number(process.env.STORAGE_GIT_CACHE_BYTES || 2 * 1024 * 1024 * 1024);
    if (!Number.isSafeInteger(target) || target < 1) throw new Error("Invalid Git cache budget.");
    const repos = [];
    for (const folder of ["repos", "projects"]) for (const entry of await readdir(join(dataRoot(), folder), { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() || !/^[a-zA-Z0-9_-]+\.git$/.test(entry.name)) continue;
      const path = join(dataRoot(), folder, entry.name);
      repos.push({ path, bytes: await directoryBytes(path), used: Number(await readFile(join(path, "multiplayer-last-used"), "utf8").catch(() => "0")) });
    }
    let bytes = repos.reduce((sum, repo) => sum + repo.bytes, 0); const archived: string[] = [];
    for (const repo of repos.sort((a,b) => a.used - b.used)) {
      if (bytes <= target) break;
      if (await archiveStoredRepo(repo.path)) { bytes -= repo.bytes; archived.push(repositoryKey(repo.path)); }
    }
    return { bytes, archived };
  })().finally(() => { trimming = null; });
  return trimming;
}
