import { lstat, mkdir, readdir, statfs } from "node:fs/promises";
import { join } from "node:path";
import { query, queryOne, transaction } from "../db/client";
import { createFileLock, repoLock } from "../session/lock";
import { barePath, dataRoot, sharedRepositoryBarePath } from "../session/paths";
import { storageConfig } from "./object-store";

export type Measurement = { bytes: number; anomaly: string | null };
export type Resource = { key: string; owner: string; path: string; lock: string };
export class StorageAdmissionError extends Error { readonly status = 507; }
export const MiB = 1024 * 1024;

export function storageLimit(): number {
  const value = Number(process.env.ORG_STORAGE_LIMIT_BYTES ?? (process.env.NODE_ENV === "production" ? 10 * 1024 * MiB : 0));
  if (!Number.isSafeInteger(value) || value < 0 || (process.env.NODE_ENV === "production" && value === 0)) throw new Error("Configure a positive ORG_STORAGE_LIMIT_BYTES in production.");
  return value;
}
export function localStorage() {
  const config = storageConfig();
  if (config.provider !== "local" || process.env.STORAGE_COLD_GIT === "1") throw new Error("Storage admission requires local, non-archived Git storage.");
  return config;
}

/** Do not follow links, or pretend permission/I/O errors mean zero usage.
 * Irregular entries are charged by their own lstat size and quarantine only
 * their resource. Ordinary symlinks committed as Git blobs are regular files. */
export async function measureDirectory(path: string): Promise<Measurement> {
  let bytes = 0, anomaly: string | null = null;
  async function visit(current: string) {
    let info;
    try { info = await lstat(current); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (info.isDirectory()) {
      for (const name of await readdir(current)) await visit(join(current, name));
    } else {
      bytes += info.size;
      if (!info.isFile()) anomaly ??= "Unexpected non-regular entry in managed storage. Ask the administrator to inspect this repository or activity directory, then reconcile its usage.";
    }
  }
  await visit(path);
  return { bytes, anomaly };
}
export async function directoryBytes(path: string) { return (await measureDirectory(path)).bytes; }

export async function storageOwner(ref: string): Promise<string> {
  const row = ref.startsWith("shared:")
    ? await queryOne<{ owner: string }>(`SELECT 'org:'||p.org_id::text AS owner FROM project_repositories r JOIN projects p ON p.id=r.project_id WHERE r.id=$1`, [ref.slice(7)])
    : await queryOne<{ owner: string }>(`SELECT COALESCE('org:'||s.org_id::text,'user:'||s.owner_id::text) AS owner FROM sessions s WHERE s.id=$1
       UNION ALL SELECT COALESCE('org:'||s.org_id::text,'user:'||s.owner_id::text) FROM room_repos r JOIN sessions s ON s.id=r.session_id WHERE r.id=$1 LIMIT 1`, [ref]);
  if (!row) throw new StorageAdmissionError("Storage ownership is unavailable. Retry after the repository is created.");
  return row.owner;
}
export function resourceFor(key: string, owner: string): Resource {
  if (key.startsWith("repo:shared:") && /^[0-9a-f-]{36}$/.test(key.slice(12))) return { key, owner, path: sharedRepositoryBarePath(key.slice(12)), lock: key.slice(5) };
  if (/^repo:[a-z2-9]{12}$/.test(key)) return { key, owner, path: barePath(key.slice(5)), lock: key.slice(5) };
  if (/^activity:[0-9a-f-]{36}$/.test(key)) { const config = localStorage(); return { key, owner, path: join(config.directory, config.prefix, "activity", key.slice(9)), lock: key }; }
  throw new Error("Invalid storage resource.");
}

/** Enumerate activity directories that actually exist, never probe every turn.
 * This is the one-time backfill / explicit inventory, not an admission scan. */
export async function inventory(owner: string): Promise<Resource[]> {
  const [kind, id] = owner.split(":");
  const rooms = await query<{ id: string }>(`SELECT id FROM sessions WHERE ${kind === "org" ? "org_id=$1" : "org_id IS NULL AND owner_id=$1"}`, [id]);
  const ids = rooms.map(room => room.id);
  const repos = await query<{ id: string }>(`SELECT id FROM room_repos WHERE session_id=ANY($1::text[])`, [ids]);
  const shared = kind === "org" ? await query<{ id: string }>(`SELECT r.id FROM project_repositories r JOIN projects p ON p.id=r.project_id WHERE p.org_id=$1`, [id]) : [];
  const config = localStorage();
  let names: string[];
  try { names = await readdir(join(config.directory, config.prefix, "activity")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; names = []; }
  const candidates = names.filter(name => /^[0-9a-f-]{36}$/.test(name));
  const turns = candidates.length ? await query<{ id: string }>(`SELECT t.id FROM agent_turns t JOIN agent_runs r ON r.id=t.run_id WHERE r.session_id=ANY($1::text[]) AND t.id=ANY($2::uuid[])`, [ids, candidates]) : [];
  return [...new Set([...ids, ...repos.map(r => r.id)].map(ref => `repo:${ref}`).concat(shared.map(r => `repo:shared:${r.id}`), turns.map(t => `activity:${t.id}`)))].map(key => resourceFor(key, owner));
}

export async function initializeOwner(owner: string) {
  if ((await queryOne<{ initialized: boolean }>(`SELECT initialized FROM storage_usage WHERE owner=$1`, [owner]))?.initialized) return;
  await (await repoLock()).withLock(`storage-owner:${owner}`, async () => {
    if ((await queryOne<{ initialized: boolean }>(`SELECT initialized FROM storage_usage WHERE owner=$1`, [owner]))?.initialized) return;
    const entries: Array<Resource & Measurement> = [];
    for (const resource of await inventory(owner)) entries.push({ ...resource, ...await measureDirectory(resource.path) });
    // No filesystem work while a SQL transaction is open.
    await transaction(async tx => {
      await tx.query(`INSERT INTO storage_usage(owner) VALUES ($1) ON CONFLICT DO NOTHING`, [owner]);
      await tx.query(`INSERT INTO storage_resources(key,owner,bytes,anomaly)
        SELECT key,$1,bytes,anomaly FROM jsonb_to_recordset($2::jsonb) AS entry(key text,bytes bigint,anomaly text)`,
        [owner, JSON.stringify(entries.map(({ key, bytes, anomaly }) => ({ key, bytes, anomaly })))]);
      await tx.query(`UPDATE storage_usage SET bytes=$2,initialized=true WHERE owner=$1`, [owner, entries.reduce((sum, entry) => sum + entry.bytes, 0)]);
    });
  });
}
export async function ownerStorageBytes(owner: string): Promise<number> {
  const cached = await queryOne<{ bytes: string; initialized: boolean }>(`SELECT bytes,initialized FROM storage_usage WHERE owner=$1`, [owner]);
  if (cached?.initialized) return Number(cached.bytes);
  await initializeOwner(owner);
  return Number((await queryOne<{ bytes: string }>(`SELECT bytes FROM storage_usage WHERE owner=$1`, [owner]))!.bytes);
}
export async function resourceUsage(resource: Resource): Promise<Measurement> {
  const row = await queryOne<{ bytes: string; anomaly: string | null }>(`SELECT bytes,anomaly FROM storage_resources WHERE key=$1 AND owner=$2`, [resource.key, resource.owner]);
  if (row) return { bytes: Number(row.bytes), anomaly: row.anomaly };
  const measured = await measureDirectory(resource.path);
  await transaction(async tx => {
    await tx.query(`SELECT owner FROM storage_usage WHERE owner=$1 FOR UPDATE`, [resource.owner]);
    const { rowCount } = await tx.query(`INSERT INTO storage_resources(key,owner,bytes,anomaly) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [resource.key, resource.owner, measured.bytes, measured.anomaly]);
    if (rowCount) await tx.query(`UPDATE storage_usage SET bytes=bytes+$2 WHERE owner=$1`, [resource.owner, measured.bytes]);
  });
  return measured;
}

/** Capacity -> owner is the common SQL lock order. Only a statfs syscall occurs
 * inside this short booking transaction; no Git, file walks, or lock probes. */
export async function reserve(resource: Resource, bytes: number, limit: number) {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > Number.MAX_SAFE_INTEGER / 2) throw new StorageAdmissionError("This storage operation is too large. Upload smaller batches.");
  const floor = Number(process.env.STORAGE_MIN_FREE_BYTES ?? 2 * 1024 * MiB);
  if (!Number.isSafeInteger(floor) || floor < 0) throw new Error("Invalid STORAGE_MIN_FREE_BYTES.");
  await mkdir(dataRoot(), { recursive: true });
  await transaction(async tx => {
    const { rows: [capacity] } = await tx.query(`SELECT reserved_bytes FROM storage_capacity WHERE id=1 FOR UPDATE`);
    const { rows: [owner] } = await tx.query(`SELECT bytes,reserved_bytes FROM storage_usage WHERE owner=$1 FOR UPDATE`, [resource.owner]);
    const { rows: [previous] } = await tx.query(`SELECT quota_bytes,disk_bytes FROM storage_reservations WHERE resource_key=$1`, [resource.key]);
    const quota = Math.max(bytes, Number(previous?.quota_bytes ?? 0));
    const disk = Math.max(4096, quota * 2);
    const quotaDelta = quota - Number(previous?.quota_bytes ?? 0), diskDelta = disk - Number(previous?.disk_bytes ?? 0);
    if (Number(owner.bytes) + Number(owner.reserved_bytes) + quotaDelta > limit) throw new StorageAdmissionError("Your organisation’s repository storage allowance is full. Ask the administrator to increase it or perform reviewed storage cleanup.");
    const free = await statfs(dataRoot());
    if (free.bavail * free.bsize - Number(capacity.reserved_bytes) - diskDelta < floor) throw new StorageAdmissionError("The server is low on disk space. Your existing work is safe; ask the administrator to free space before uploading more.");
    await tx.query(`INSERT INTO storage_reservations(resource_key,quota_bytes,disk_bytes) VALUES ($1,$2,$3) ON CONFLICT(resource_key) DO UPDATE SET quota_bytes=EXCLUDED.quota_bytes,disk_bytes=EXCLUDED.disk_bytes`, [resource.key, quota, disk]);
    await tx.query(`UPDATE storage_usage SET reserved_bytes=reserved_bytes+$2 WHERE owner=$1`, [resource.owner, quotaDelta]);
    await tx.query(`UPDATE storage_capacity SET reserved_bytes=reserved_bytes+$1 WHERE id=1`, [diskDelta]);
  });
}

/** Commit actual bytes and release the reservation together. On any failure the
 * dirty marker survives, so the next lock holder must measure before writing. */
export async function settle(resource: Resource, measured: Measurement) {
  await transaction(async tx => {
    await tx.query(`SELECT id FROM storage_capacity WHERE id=1 FOR UPDATE`);
    await tx.query(`SELECT owner FROM storage_usage WHERE owner=$1 FOR UPDATE`, [resource.owner]);
    const { rows: [previous] } = await tx.query(`SELECT bytes FROM storage_resources WHERE key=$1 FOR UPDATE`, [resource.key]);
    const { rows: [reservation] } = await tx.query(`DELETE FROM storage_reservations WHERE resource_key=$1 RETURNING quota_bytes,disk_bytes`, [resource.key]);
    await tx.query(`UPDATE storage_resources SET bytes=$2,anomaly=$3,measured_at=now() WHERE key=$1`, [resource.key, measured.bytes, measured.anomaly]);
    await tx.query(`UPDATE storage_usage SET bytes=bytes+$2,reserved_bytes=reserved_bytes-$3 WHERE owner=$1`, [resource.owner, measured.bytes - Number(previous.bytes), Number(reservation?.quota_bytes ?? 0)]);
    await tx.query(`UPDATE storage_capacity SET reserved_bytes=reserved_bytes-$1 WHERE id=1`, [Number(reservation?.disk_bytes ?? 0)]);
  });
}
export async function recoverResource(resource: Resource): Promise<boolean> {
  if (!await queryOne(`SELECT resource_key FROM storage_reservations WHERE resource_key=$1`, [resource.key])) return false;
  await settle(resource, await measureDirectory(resource.path));
  return true;
}

/** Explicit/background recovery only. Probes run outside SQL/capacity locks,
 * once per dirty resource, and never reclaim a live or stopped Git process. */
export async function recoverStorageReservations(minimumAgeMs = 0) {
  if (!Number.isSafeInteger(minimumAgeMs) || minimumAgeMs < 0) throw new Error("Invalid storage recovery age.");
  const rows = await query<{ key: string; owner: string }>(`SELECT r.key,r.owner FROM storage_reservations s JOIN storage_resources r ON r.key=s.resource_key
    WHERE s.created_at <= now()-($1::bigint * interval '1 millisecond') ORDER BY s.checked_at NULLS FIRST,s.created_at LIMIT 100`, [minimumAgeMs]);
  const probe = createFileLock({ acquireTimeoutMs: 1 });
  const recovered: string[] = [], busy: string[] = [], failed: string[] = [];
  for (const row of rows) {
    const resource = resourceFor(row.key, row.owner);
    // Rotate the bounded batch so a stopped writer cannot starve later recovery.
    await query(`UPDATE storage_reservations SET checked_at=now() WHERE resource_key=$1`, [row.key]);
    try { await probe.withLock(resource.lock, async () => { if (await recoverResource(resource)) recovered.push(resource.key); }); }
    catch (error) {
      if (error instanceof Error && error.message.startsWith("Repository is busy")) busy.push(resource.key);
      else { failed.push(resource.key); console.error("Storage recovery deferred", resource.key, error); }
    }
  }
  return { recovered, busy, failed };
}

export async function reconcileOwnerStorage(owner: string) {
  await initializeOwner(owner);
  const resources = new Map((await inventory(owner)).map(resource => [resource.key, resource]));
  // Include tracked paths whose metadata was removed: orphan bytes still count.
  for (const row of await query<{ key: string }>(`SELECT key FROM storage_resources WHERE owner=$1`, [owner])) resources.set(row.key, resourceFor(row.key, owner));
  for (const resource of resources.values()) await (await repoLock()).withLock(resource.lock, async () => {
    await resourceUsage(resource);
    await settle(resource, await measureDirectory(resource.path));
  });
  return ownerStorageBytes(owner);
}
