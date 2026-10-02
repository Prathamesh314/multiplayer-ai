import { AsyncLocalStorage } from "node:async_hooks";
import { randomInt } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, statfs, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { query, queryOne } from "../db/client";
import { createFileLock, repoLock } from "../session/lock";
import { barePath, dataRoot, sharedRepositoryBarePath } from "../session/paths";
import { storageConfig } from "./object-store";

const MiB = 1024 * 1024;
const active = new AsyncLocalStorage<{ id: string; ref: string; owner: string; limit: number; reserved: number; active: boolean }>();
export class StorageAdmissionError extends Error {
  readonly status = 507;
}
export function storageLimit(): number {
  const value = Number(process.env.ORG_STORAGE_LIMIT_BYTES ?? (process.env.NODE_ENV === "production" ? 10 * 1024 * MiB : 0));
  if (!Number.isSafeInteger(value) || value < 0 || (process.env.NODE_ENV === "production" && value === 0)) throw new Error("Configure a positive ORG_STORAGE_LIMIT_BYTES in production.");
  return value;
}
export async function directoryBytes(path: string): Promise<number> {
  let entries;
  try { entries = await readdir(path, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0; throw error; }
  let bytes = 0;
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) bytes += await directoryBytes(child);
    else if (entry.isFile()) bytes += (await stat(child)).size;
    else throw new Error("Unexpected symlink in managed storage.");
  }
  return bytes;
}
export async function storageOwner(ref: string): Promise<string> {
  const row = ref.startsWith("shared:")
    ? await queryOne<{ owner: string }>(`SELECT 'org:'||p.org_id::text AS owner FROM project_repositories r JOIN projects p ON p.id=r.project_id WHERE r.id=$1`, [ref.slice(7)])
    : await queryOne<{ owner: string }>(`SELECT COALESCE('org:'||s.org_id::text,'user:'||s.owner_id::text) AS owner FROM sessions s WHERE s.id=$1
       UNION ALL SELECT COALESCE('org:'||s.org_id::text,'user:'||s.owner_id::text) FROM room_repos r JOIN sessions s ON s.id=r.session_id WHERE r.id=$1 LIMIT 1`, [ref]);
  if (!row) throw new StorageAdmissionError("Storage ownership is unavailable. Retry after the repository is created.");
  return row.owner;
}
/** Count durable file bytes, including abandoned imports and unreferenced Git objects.
 * Personal rooms share a per-user allowance; organisation rooms share one allowance.
 * Database/embedding storage is separate from this repository/activity allowance. */
export async function ownerStorageBytes(owner: string): Promise<number> {
  const [kind, id] = owner.split(":");
  const rooms = await query<{ id: string }>(`SELECT id FROM sessions WHERE ${kind === "org" ? "org_id=$1" : "org_id IS NULL AND owner_id=$1"}`, [id]);
  const ids = rooms.map(room => room.id);
  const repos = await query<{ id: string }>(`SELECT id FROM room_repos WHERE session_id=ANY($1::text[])`, [ids]);
  const shared = kind === "org" ? await query<{ id: string }>(`SELECT r.id FROM project_repositories r JOIN projects p ON p.id=r.project_id WHERE p.org_id=$1`, [id]) : [];
  let bytes = 0;
  for (const ref of [...ids, ...repos.map(repo => repo.id)]) bytes += await directoryBytes(barePath(ref));
  for (const ref of shared) bytes += await directoryBytes(sharedRepositoryBarePath(ref.id));
  const config = storageConfig();
  if (config.provider !== "local" || process.env.STORAGE_COLD_GIT === "1") throw new Error("Storage admission currently requires local, non-archived Git storage. Keep cold storage disabled in this beta profile.");
  const turns = await query<{ id: string }>(`SELECT t.id FROM agent_turns t JOIN agent_runs r ON r.id=t.run_id WHERE r.session_id=ANY($1::text[])`, [ids]);
  for (const turn of turns) bytes += await directoryBytes(join(config.directory, config.prefix, "activity", turn.id));
  return bytes;
}

/** A crashed writer leaves its reservation. Reclaim only after proving its
 * kernel lock is free; wall-clock expiry cannot prove a paused writer is gone. */
async function reserveCapacity(id: string, bytes: number) {
  const directory = join(dataRoot(), "storage-reservations");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = await repoLock();
  const probe = createFileLock({ acquireTimeoutMs: 1 });
  await lock.withLock("storage-capacity", async () => {
    let reserved = 0;
    for (const name of await readdir(directory)) {
      if (!/^(?:[0-9]|[12][0-9]|3[01])\.json$/.test(name) || name === `${id}.json`) continue;
      const file = join(directory, name);
      try { await probe.withLock(`storage-operation:${name.slice(0, -5)}`, () => rm(file, { force: true })); }
      catch (error) {
        if (!(error instanceof Error) || !error.message.startsWith("Repository is busy")) throw error;
        const other = JSON.parse(await readFile(file, "utf8"));
        if (!Number.isSafeInteger(other.bytes) || other.bytes < 0) throw new Error("Invalid storage reservation.");
        reserved += other.bytes;
      }
    }
    const floor = Number(process.env.STORAGE_MIN_FREE_BYTES ?? 2 * 1024 * MiB);
    if (!Number.isSafeInteger(floor) || floor < 0) throw new Error("Invalid STORAGE_MIN_FREE_BYTES.");
    const fs = await statfs(dataRoot());
    if (fs.bavail * fs.bsize - reserved - bytes < floor) throw new StorageAdmissionError("The server is low on disk space. Your existing work is safe; ask the administrator to free space before uploading more.");
    await writeFile(join(directory, `${id}.json`), JSON.stringify({ bytes }), { flag: "w", mode: 0o600 });
  });
  return () => rm(join(directory, `${id}.json`), { force: true });
}

export async function requireStorageGrowth(bytes: number) {
  const state = active.getStore();
  if (!state) return;
  if (!state.active) throw new Error("Storage operation outlived admission.");
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new StorageAdmissionError("This storage operation is too large. Upload smaller batches or ask the administrator to increase the allowance.");
  if (await ownerStorageBytes(state.owner) + bytes > state.limit) throw new StorageAdmissionError("Your organisation’s repository storage allowance is full. Ask the administrator to increase it or remove unused repositories before uploading more.");
  if (bytes > state.reserved) { await reserveCapacity(state.id, bytes * 2); state.reserved = bytes * 2; }
}
export async function withStorageAdmission<T>(ref: string, task: () => Promise<T>, growth = 32 * MiB): Promise<T> {
  const limit = storageLimit();
  if (!limit) return task();
  if (active.getStore()) {
    if (!active.getStore()!.active) throw new Error("Storage operation outlived admission.");
    if (ref !== active.getStore()!.ref && await storageOwner(ref) !== active.getStore()!.owner) throw new Error("Cannot nest writes across storage owners.");
    return task();
  }
  const owner = await storageOwner(ref), lock = await repoLock();
  return lock.withLock(`storage-owner:${owner}`, async () => {
    // Fixed slots bound lock-file/inode growth; a slot is never reused while
    // its previous process or Git child still holds the kernel lock.
    const id = String(randomInt(32));
    return lock.withLock(`storage-operation:${id}`, async () => {
      // Bound transient uploads too. File bytes are counted conservatively per
      // copy, including hardlinks, rather than promising physical block quotas.
      const reserved = Math.max(256 * MiB, growth * 2);
      const release = await reserveCapacity(id, reserved);
      const state = { id, ref, owner, limit, reserved, active: true };
      try { return await active.run(state, async () => { await requireStorageGrowth(growth); return task(); }); }
      finally { state.active = false; await release(); }
    });
  });
}
