import { AsyncLocalStorage } from "node:async_hooks";
import { lstat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { queryOne } from "../db/client";
import { repoLock } from "../session/lock";
import { barePath, sharedRepositoryBarePath } from "../session/paths";
import { directoryBytes, initializeOwner, localStorage, measureDirectory, MiB, recoverResource, reserve, resourceFor, resourceUsage, settle, storageLimit, storageOwner, StorageAdmissionError, type Resource } from "./accounting";

export { directoryBytes, ownerStorageBytes, storageLimit, storageOwner, StorageAdmissionError } from "./accounting";
type Operation = { resource: Resource; limit: number; reserved: number; active: boolean; delta: number; uncertain: boolean };
const active = new AsyncLocalStorage<{ current: Operation; operations: Map<string, Operation> }>();

/** Growth checks are indexed bookings, never owner or repository scans. */
export async function requireStorageGrowth(bytes: number, ref?: string) {
  const context = active.getStore();
  if (!context) return;
  const state = ref ? context.operations.get(`repo:${ref}`) : context.current;
  if (!state?.active) throw new Error("Storage operation outlived admission or does not own this repository.");
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new StorageAdmissionError("This storage operation is too large. Upload smaller batches.");
  if (bytes > state.reserved) { await reserve(state.resource, bytes, state.limit); state.reserved = bytes; }
}

/** The resource lock spans mutation, accounting and any surviving Git children.
 * Other repositories (including ones with the same owner) remain concurrent. */
async function admit<T>(ref: string, key: string, task: () => Promise<T>, growth: number, incremental: boolean): Promise<T> {
  const limit = storageLimit();
  if (!limit) return task();
  localStorage();
  const context = active.getStore(), existing = context?.operations.get(key);
  if (context && !context.current.active) throw new Error("Storage operation outlived admission.");
  if (existing) {
    if (!existing.active) throw new Error("Storage operation outlived admission.");
    // Reentrant promotion can run inside a caller's SQL transaction. Do not
    // issue another booking/query when the existing allowance already covers it.
    if (growth > existing.reserved) await reserve(existing.resource, growth, limit);
    existing.reserved = Math.max(existing.reserved, growth);
    return active.run({ ...context!, current: existing }, task);
  }
  const owner = await storageOwner(ref);
  if (context && context.current.resource.owner !== owner) throw new Error("Cannot nest writes across storage owners.");
  await initializeOwner(owner);
  const resource = resourceFor(key, owner);
  return (await repoLock()).withLock(resource.lock, async () => {
    const previous = await resourceUsage(resource);
    // Acquiring the same inherited kernel lock proves an earlier writer and
    // its Git children have finished. Recover BEFORE admitting another write.
    const recovered = await recoverResource(resource);
    const baseline = recovered ? await resourceUsage(resource) : previous;
    if (baseline.anomaly) throw new StorageAdmissionError(baseline.anomaly);
    await reserve(resource, growth, limit);
    const state: Operation = { resource, limit, reserved: growth, active: true, delta: 0, uncertain: false };
    const operations = new Map(context?.operations ?? []); operations.set(key, state);
    let failed = false;
    try { return await active.run({ current: state, operations }, task); }
    catch (error) { failed = true; throw error; }
    finally {
      state.active = false;
      // Git changes compressed objects, packs, refs and indexes outside Node.
      // Measure the affected repository once, including unsuccessful writes.
      // Normal activity writes account exact changed object bytes without a walk.
      try {
        const measured = incremental && !failed && !state.uncertain
          ? { bytes: baseline.bytes + state.delta, anomaly: null }
          : await measureDirectory(resource.path);
        await settle(resource, measured);
      } catch (error) {
        // Do not clear the reservation when measurement/settlement fails.
        console.error("Storage accounting requires recovery", resource.key, error);
        if (!failed) throw new StorageAdmissionError("Your operation finished, but its storage usage could not be confirmed. Retry to recover its accounting before making more changes.");
      }
    }
  });
}

export function withStorageAdmission<T>(ref: string, task: () => Promise<T>, growth = 32 * MiB): Promise<T> {
  return admit(ref, `repo:${ref}`, task, growth, false);
}
export function withActivityStorageAdmission<T>(sessionId: string, turnId: string, task: () => Promise<T>, growth: number): Promise<T> {
  return admit(sessionId, `activity:${turnId}`, task, growth, true);
}

/** Activity objects are compressed and deduplicated by key. Measure the old and
 * replacement file, not uncompressed batch bytes or a sum of sequence rows. */
export async function trackActivityWrite<T>(path: string, write: () => Promise<T>): Promise<T> {
  const state = active.getStore()?.current;
  if (!state) return write();
  if (!state.active) throw new Error("Storage operation outlived admission.");
  const child = relative(state.resource.path, resolve(path));
  if (!state.resource.key.startsWith("activity:") || !child || child.startsWith("..") || child.includes("/")) throw new Error("Activity write escaped its storage resource.");
  const size = async () => {
    try { const info = await lstat(path); if (!info.isFile()) throw new Error("Unexpected non-regular activity object."); return info.size; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0; throw error; }
  };
  try {
    const before = await size();
    const result = await write();
    state.delta += await size() - before;
    return result;
  } catch (error) { state.uncertain = true; throw error; }
}

/** Copy/fetch sizing uses the existing resource ledger, rather than walking the
 * source repository again. Admission-off development retains the old fallback. */
export async function repositoryStorageBytes(ref: string): Promise<number> {
  if (!storageLimit()) return directoryBytes(ref.startsWith("shared:") ? sharedRepositoryBarePath(ref.slice(7)) : barePath(ref));
  const owner = await storageOwner(ref); await initializeOwner(owner);
  const row = await queryOne<{ bytes: string }>(`SELECT bytes FROM storage_resources WHERE key=$1 AND owner=$2`, [`repo:${ref}`, owner]);
  return row ? Number(row.bytes) : 0;
}
