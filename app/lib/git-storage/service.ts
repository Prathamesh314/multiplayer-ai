import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { query, queryOne, transaction } from "../db/client";
import type { PoolClient } from "pg";
import { createMemoryLock } from "../session/lock";
import { gitStorageConfig, withStorageConfig, type RepoKey, type StorageConfig } from "./config";
import { s3ObjectStore, type GitObjectStore } from "./objects";

const exec = promisify(execFile);
export async function storageGit(cwd: string, args: string[]) {
  return (await exec("git", ["-c", "user.name=multiplayer-ai", "-c", "user.email=storage@multiplayer-ai.local", "-c", "commit.gpgsign=false", ...args],
    { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1" }, maxBuffer: 64 * 1024 * 1024 })).stdout;
}
const exists = (path: string) => stat(path).then(() => true, () => false);
const sameRefs = (a: Record<string,string>, b: Record<string,string>) =>
  Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([ref,sha]) => b[ref] === sha);
export async function hashFile(path: string) {
  const hash = createHash("sha256");
  for await (const data of createReadStream(path)) hash.update(data);
  return hash.digest("hex");
}
export type RepositoryState = {
  repo_key: RepoKey; initialized: boolean; bundle_key: string | null; bundle_sha256: string | null;
  refs: Record<string, string>; head: string; revision: string; fence: string;
  lease_token: string; lease_until: Date;
};
type Lease = { state: RepositoryState; lost: boolean };
type Operation = { service: GitStorageService; leases: Map<RepoKey, Lease> };
const active = new AsyncLocalStorage<Operation>();
export const inStorageOperation = () => !!active.getStore();

/** A Git service over a pluggable immutable object store. Every writer uses a
 * fenced DB lease; no ref is acknowledged until its bundle upload AND manifest
 * transaction complete. Node-local directories are never a recovery source. */
export class GitStorageService {
  private locks = createMemoryLock();
  private cached = new Map<RepoKey, string>();
  constructor(readonly config: StorageConfig, readonly objects: GitObjectStore) {}
  bare(key: RepoKey) { return join(this.config.cacheRoot, `${key}.git`); }
  work(key: RepoKey) { return join(this.config.cacheRoot, "work", key.split("/")[1]); }

  private async acquire(key: RepoKey): Promise<Lease> {
    await query(`INSERT INTO git_repositories(repo_key) VALUES ($1) ON CONFLICT DO NOTHING`, [key]);
    const deadline = Date.now() + 60_000, token = randomUUID();
    do {
      const state = await queryOne<RepositoryState>(`UPDATE git_repositories SET lease_token=$2,
        lease_until=clock_timestamp()+interval '45 seconds',fence=fence+1
        WHERE repo_key=$1 AND (lease_until IS NULL OR lease_until<clock_timestamp()) RETURNING *`, [key,token]);
      if (state) return { state, lost: false };
      await new Promise(resolve => setTimeout(resolve, 50 + Math.random()*100));
    } while (Date.now() < deadline);
    throw new Error(`Timed out acquiring repository lease: ${key}`);
  }

  async withRepositories<T>(keys: RepoKey[], write: boolean, task: () => Promise<T>, options: { maintenance?: boolean } = {}): Promise<T> {
    return withStorageConfig(this.config,()=>this.withLockedRepositories(keys,write,task,options));
  }
  private async withLockedRepositories<T>(keys: RepoKey[], write: boolean, task: () => Promise<T>, options: { maintenance?: boolean }): Promise<T> {
    const ordered = [...new Set(keys)].sort();
    const parent = active.getStore();
    if (parent) {
      if (parent.service !== this || ordered.some(key => !parent.leases.has(key))) throw new Error("Nested Git operation must declare all repositories up front.");
      const result = await task();
      // Checkpoint before returning even inside an outer database transaction.
      if (write) await this.publish(ordered, parent.leases);
      return result;
    }
    const lock = (index: number): Promise<T> => index < ordered.length
      ? this.locks.withLock(ordered[index], () => lock(index+1))
      : this.run(ordered, write, task, options);
    return lock(0);
  }

  private async run<T>(keys: RepoKey[], write: boolean, task: () => Promise<T>, options: { maintenance?: boolean }): Promise<T> {
    const leases = new Map<RepoKey, Lease>();
    let renewing = false;
    const timer = setInterval(() => {
      if (renewing) return;
      renewing = true;
      void Promise.all([...leases.values()].map(async lease => {
        try {
          const renewed = await query(`UPDATE git_repositories SET lease_until=clock_timestamp()+interval '45 seconds'
            WHERE repo_key=$1 AND lease_token=$2 AND fence=$3 AND lease_until>clock_timestamp() RETURNING repo_key`,
          [lease.state.repo_key,lease.state.lease_token,lease.state.fence]);
          if (!renewed.length) lease.lost = true;
        } catch { lease.lost = true; }
      })).finally(() => { renewing = false; });
    }, 10_000);
    timer.unref();
    try {
      for (const key of keys) leases.set(key, await this.acquire(key));
      for (const [key,lease] of leases) {
        // Only operator backfill/verification opts in; normal API operations
        // must never make a deleted room's code available.
        if (!options.maintenance) await this.assertNotDeleted(key);
        await this.hydrate(lease.state);
      }
      return await active.run({ service: this, leases }, async () => {
        const result = await task();
        if (write) await this.publish(keys, leases);
        if ([...leases.values()].some(lease => lease.lost)) throw new Error("Repository lease lost; retry the operation.");
        return result;
      });
    } catch (cause) {
      for (const key of keys) this.cached.delete(key);
      throw cause;
    } finally {
      clearInterval(timer);
      for (const [key,lease] of leases) await query(`UPDATE git_repositories SET lease_token=NULL,lease_until=NULL
        WHERE repo_key=$1 AND lease_token=$2 AND fence=$3`, [key,lease.state.lease_token,lease.state.fence]).catch(() => {});
    }
  }

  private async assertNotDeleted(key: RepoKey) {
    if (!key.startsWith("repos/")) return;
    const id = key.slice(6);
    const deleted = await queryOne(`SELECT s.id FROM sessions s LEFT JOIN room_repos r ON r.session_id=s.id
      WHERE (s.id=$1 OR r.id=$1) AND s.deleted_at IS NOT NULL LIMIT 1`, [id]);
    if (deleted) throw new Error("Repository belongs to a deleted room. Restore the room before using it.");
  }

  private async hydrate(state: RepositoryState) {
    const key = state.repo_key, bare = this.bare(key);
    if (this.config.mode === "shadow") return; // explicit migration stage: legacy disk is the read source
    if (!state.initialized) {
      const id=key.split('/')[1];
      const confirmed=key.startsWith('projects/')
        ? await queryOne(`SELECT r.head_sha FROM session_repos r JOIN sessions s ON s.id=r.session_id WHERE s.project_id=$1 LIMIT 1`,[id])
        : await queryOne(`SELECT head_sha FROM session_repos WHERE session_id=$1
            UNION ALL SELECT head_sha FROM room_repos WHERE id=$1 AND head_sha IS NOT NULL`,[id]);
      if(confirmed) throw new Error('Repository has confirmed history but no cloud manifest. Complete shadow backfill before using cloud storage.');
    }
    if (this.cached.get(key) === String(state.revision) && await exists(bare)
      && (!key.startsWith("repos/") || await exists(this.work(key)))) return;
    await rm(bare, { recursive: true, force: true });
    if (key.startsWith("repos/")) await rm(this.work(key), { recursive: true, force: true });
    if (!state.initialized) return;
    await mkdir(dirname(bare), { recursive: true });
    if (state.bundle_key) {
      const file = join(this.config.cacheRoot, `.restore-${randomUUID()}.bundle`);
      try {
        await this.objects.getFile(state.bundle_key, file);
        if (await hashFile(file) !== state.bundle_sha256) throw new Error("Git bundle checksum mismatch.");
        await storageGit(dirname(bare), ["clone", "--mirror", file, bare]);
        await storageGit(bare, ["symbolic-ref", "HEAD", state.head]);
        const actual = await this.refs(bare);
        if (!sameRefs(actual,state.refs)) throw new Error("Git bundle refs do not match the authoritative manifest.");
      } finally { await rm(file, { force: true }); }
    } else await storageGit(dirname(bare), ["init", "--bare", "-b", "main", bare]);
    if (key.startsWith("repos/")) {
      const work = this.work(key), id = key.slice(6);
      await mkdir(dirname(work), { recursive: true });
      const branch = state.refs[`refs/heads/session/${id}`] ? `session/${id}` : "main";
      if (Object.keys(state.refs).length) await storageGit(dirname(work), ["clone", "--branch", branch, bare, work]);
      else {
        await mkdir(work, { recursive: true });
        await storageGit(work, ["init", "-b", "main"]);
        await storageGit(work, ["remote", "add", "origin", bare]);
      }
    }
    this.cached.set(key, String(state.revision));
  }

  private async refs(bare: string): Promise<Record<string,string>> {
    const text = await storageGit(bare, ["for-each-ref", "--format=%(refname) %(objectname)"]);
    return Object.fromEntries(text.trim().split("\n").filter(Boolean).map(line => line.split(" ")));
  }

  private async publish(keys: RepoKey[], leases: Map<RepoKey, Lease>) {
    const snapshots: Array<{ lease: Lease; refs: Record<string,string>; head: string; object: string|null; hash: string|null }> = [];
    for (const key of keys) {
      const lease = leases.get(key)!;
      if (lease.lost) throw new Error("Repository lease lost before publication.");
      const bare = this.bare(key);
      if (!await exists(bare)) continue;
      const refs = await this.refs(bare), head = (await storageGit(bare, ["symbolic-ref", "HEAD"])).trim();
      if (lease.state.initialized && sameRefs(refs,lease.state.refs) && head === lease.state.head) continue;
      let object: string|null = null, hash: string|null = null;
      if (Object.keys(refs).length) {
        const file = join(this.config.cacheRoot, `.upload-${randomUUID()}.bundle`);
        try {
          await storageGit(bare, ["bundle", "create", file, "--all"]);
          await storageGit(bare, ["bundle", "verify", file]);
          hash = await hashFile(file); object = `bundles/${hash}.bundle`;
          await this.objects.putFile(object, file);
        } finally { await rm(file, { force: true }); }
      }
      snapshots.push({ lease,refs,head,object,hash });
    }
    // Multi-repo publish (room + project) becomes visible atomically.
    const updated = await transaction(async tx => {
      for (const key of keys) {
        const lease=leases.get(key)!;
        const {rows}=await tx.query(`SELECT repo_key FROM git_repositories WHERE repo_key=$1
          AND lease_token=$2 AND fence=$3 AND lease_until>clock_timestamp() FOR UPDATE`,
        [key,lease.state.lease_token,lease.state.fence]);
        if(!rows.length || lease.lost) throw new Error("Repository lease expired; stale writer cannot publish refs.");
      }
      const result: RepositoryState[] = [];
      for (const snapshot of snapshots) {
        const {lease,refs,head,object,hash} = snapshot;
        const {rows:[state]} = await tx.query<RepositoryState>(`UPDATE git_repositories SET initialized=true,
          bundle_key=$4,bundle_sha256=$5,refs=$6,head=$7,revision=revision+1,updated_at=now()
          WHERE repo_key=$1 AND lease_token=$2 AND fence=$3 AND lease_until>clock_timestamp() RETURNING *`,
        [lease.state.repo_key,lease.state.lease_token,lease.state.fence,object,hash,JSON.stringify(refs),head]);
        if (!state || lease.lost) throw new Error("Repository lease expired; stale writer cannot publish refs.");
        await tx.query(`INSERT INTO git_storage_history(repo_key,revision,bundle_key,bundle_sha256,refs,head)
          VALUES ($1,$2,$3,$4,$5,$6)`, [state.repo_key,state.revision,object,hash,JSON.stringify(refs),head]);
        result.push(state);
      }
      return result;
    });
    for (const state of updated) {
      leases.get(state.repo_key)!.state = state;
      this.cached.set(state.repo_key,String(state.revision));
    }
  }

  async checkpoint(keys: RepoKey[]) {
    const operation = active.getStore();
    if (operation?.service !== this) throw new Error("Checkpoint requires a repository operation.");
    await this.publish(keys,operation.leases);
  }
}

const services = new Map<string,Promise<GitStorageService>>();
export async function gitStorageService(): Promise<GitStorageService> {
  const operation=active.getStore();
  if(operation) return operation.service;
  const config = gitStorageConfig(), key = JSON.stringify(config);
  let service = services.get(key);
  if (!service) {
    service = s3ObjectStore(config).then(objects => new GitStorageService(config,objects));
    services.set(key,service);
  }
  return service;
}
export async function withGitRepositories<T>(keys: RepoKey[], write: boolean, task: () => Promise<T>): Promise<T> {
  if (gitStorageConfig().mode === "local") return task();
  return (await gitStorageService()).withRepositories(keys,write,task);
}

/** Fence dependent Postgres metadata in the same transaction that updates it.
 * Row locks prevent a replacement writer acquiring a lease until commit. */
export async function lockGitMetadata(tx: PoolClient) {
  const operation=active.getStore();
  if(!operation) return;
  for(const [key,lease] of operation.leases) {
    const {rows}=await tx.query(`SELECT repo_key FROM git_repositories WHERE repo_key=$1
      AND lease_token=$2 AND fence=$3 AND lease_until>clock_timestamp() FOR UPDATE`,[key,lease.state.lease_token,lease.state.fence]);
    if(!rows.length || lease.lost) throw new Error('Repository writer lost its lease before metadata update.');
  }
}
export async function authoritativeHead(tx: PoolClient,id:string,localHead:string) {
  if(gitStorageConfig().mode==='local') return localHead;
  await lockGitMetadata(tx);
  const {rows:[row]}=await tx.query<{refs:Record<string,string>}>(`SELECT refs FROM git_repositories WHERE repo_key=$1 AND initialized FOR UPDATE`,[`repos/${id}`]);
  const head=row?.refs[`refs/heads/session/${id}`];
  if(!head) throw new Error('Repository head has not been durably published.');
  return head;
}
