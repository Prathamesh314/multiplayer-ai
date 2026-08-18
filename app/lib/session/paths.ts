import { resolve, sep } from "node:path";

/**
 * Everything durable lives under one root so it can be backed up or wiped as a
 * unit:
 *
 *   <root>/sessions.json     session records (the only metadata store)
 *   <root>/repos/<id>.git    bare repo — the record for a session
 *   <root>/work/<id>         checked-out copy — a cache, safe to delete
 */
export function dataRoot(): string {
  const configured = process.env.MULTIPLAYER_AI_DATA;
  return configured ? resolve(configured) : resolve(process.cwd(), ".multiplayer-ai");
}

export function storeFile(): string {
  return resolve(dataRoot(), "sessions.json");
}

export function barePath(id: string): string {
  return resolve(dataRoot(), "repos", `${id}.git`);
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
