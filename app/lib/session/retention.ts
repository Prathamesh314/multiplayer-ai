import { rm } from "node:fs/promises";
import { barePath, workPath } from "./paths";
import { allSessions, deleteSession, markArchived } from "./store";

/**
 * Branch-per-session generates repos faster than anyone deletes them, so the
 * policy is enforced here rather than left to whoever remembers.
 *
 * Two stages, because they have very different consequences:
 *
 *   archive  reclaims `work/<id>` only. The bare repo and the record survive,
 *            so the session still opens — the next read rebuilds the cache.
 *            Lossless, and therefore the aggressive one.
 *   delete   removes the record and the bare repo. This destroys code, so it
 *            is far enough out to be a real decision, and pinning opts out.
 */
const DAY_MS = 24 * 60 * 60 * 1000;

function days(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

export function archiveAfterDays(): number {
  return days("MULTIPLAYER_AI_ARCHIVE_DAYS", 7);
}

export function deleteAfterDays(): number {
  return days("MULTIPLAYER_AI_DELETE_DAYS", 30);
}

export type SweepResult = { archived: string[]; deleted: string[] };

export async function sweep(): Promise<SweepResult> {
  const now = Date.now();
  const archiveBefore = now - archiveAfterDays() * DAY_MS;
  const deleteBefore = now - deleteAfterDays() * DAY_MS;

  const archived: string[] = [];
  const deleted: string[] = [];

  for (const session of await allSessions()) {
    if (session.pinned) continue;

    if (session.lastActiveAt < deleteBefore) {
      await rm(workPath(session.id), { recursive: true, force: true });
      await rm(barePath(session.id), { recursive: true, force: true });
      await deleteSession(session.id);
      deleted.push(session.id);
      continue;
    }

    if (session.lastActiveAt < archiveBefore && session.archivedAt === null) {
      await rm(workPath(session.id), { recursive: true, force: true });
      await markArchived(session.id);
      archived.push(session.id);
    }
  }

  return { archived, deleted };
}

/** Removes one session outright, repo included. */
export async function purge(id: string): Promise<void> {
  await rm(workPath(id), { recursive: true, force: true });
  await rm(barePath(id), { recursive: true, force: true });
  await deleteSession(id);
}

const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
let lastSweep = 0;
let running: Promise<SweepResult> | null = null;

/**
 * Sweeps at most every ten minutes, and never lets a caller wait on it. There
 * is no scheduler in this app, so the session list is the trigger.
 */
export function sweepInBackground(): void {
  const now = Date.now();
  if (running || now - lastSweep < SWEEP_INTERVAL_MS) return;

  lastSweep = now;
  running = sweep();
  void running
    .catch(() => ({ archived: [], deleted: [] }))
    .finally(() => {
      running = null;
    });
}
