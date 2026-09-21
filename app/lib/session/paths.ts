import { resolve, sep } from "node:path";
import { gitStorageConfig } from "../git-storage/config";

/**
 * Session *metadata* lives in Postgres (the `sessions` table, migration 005);
 * this root holds the Git cache each record points at. In cloud mode, S3 bundles
 * and Postgres refs are durable; testing/shadow retain the legacy disk layout:
 *
 *   <root>/repos/<id>.git    bare repo — cached confirmed session history
 *   <root>/projects/<id>.git bare repo — a project's canonical `main`
 *   <root>/work/<id>         checked-out copy — a cache, safe to delete
 *
 * A legacy `<root>/sessions.json` may still exist from before the Postgres
 * migration; it is read once by `db/import-sessions.mjs` and is not a store.
 */
export function dataRoot(): string {
  return gitStorageConfig().cacheRoot;
}

export function barePath(id: string): string {
  return resolve(dataRoot(), "repos", `${id}.git`);
}

/**
 * The project's canonical repo — the single source of truth its rooms fork from
 * and publish back to. A room is a branch; this holds the `main` they share.
 */
export function projectBarePath(projectId: string): string {
  return resolve(dataRoot(), "projects", `${projectId}.git`);
}

export function workPath(id: string): string {
  return resolve(dataRoot(), "work", id);
}

/** Session ids are generated from a fixed alphabet; anything else is a probe. */
export function isSessionId(candidate: unknown): candidate is string {
  return typeof candidate === "string" && /^[a-z2-9]{12}$/.test(candidate);
}

const MAX_PATH_LENGTH = 1024;

/**
 * Normalises a repo-relative path supplied by a client, or returns null.
 *
 * Rejects absolute paths, traversal, and anything addressing `.git` — a write
 * into `.git/hooks` would be arbitrary code execution the next time git runs.
 */
export function safeRelativePath(candidate: unknown): string | null {
  if (typeof candidate !== "string") return null;

  const path = candidate.replace(/\\/g, "/").trim();
  if (path.length === 0 || path.length > MAX_PATH_LENGTH) return null;
  if (path.includes("\0")) return null;
  // Absolute POSIX, Windows drive letter, or UNC.
  if (path.startsWith("/") || /^[a-zA-Z]:/.test(path)) return null;

  const segments = path.split("/");
  for (const segment of segments) {
    if (segment.length === 0 || segment === "." || segment === "..") return null;
    if (segment.toLowerCase() === ".git") return null;
  }

  return segments.join("/");
}

/**
 * Resolves `relative` inside `root`, returning null if the result escapes it.
 * Belt and braces on top of `safeRelativePath`, since symlinks and unicode
 * normalisation can still surprise.
 */
export function resolveInside(root: string, relative: string): string | null {
  const absolute = resolve(root, relative);
  const prefix = root.endsWith(sep) ? root : root + sep;
  return absolute.startsWith(prefix) ? absolute : null;
}
