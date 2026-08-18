import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { storeFile } from "./paths";
import type { Session, SessionRepo } from "./types";

export type StoredSession = Session & {
  /** Secret held only in the creator's cookie — never sent in a URL. */
  key: string;
  /**
   * External remote discovered from the uploaded `.git/config`, when there was
   * one. The session's own bare repo is always derivable from the id, so it is
   * not stored; this is the only repo URL that carries information.
   */
  upstreamUrl: string | null;
};

/**
 * Sessions are persisted to one JSON file. They have to outlive the process:
 * once a session owns a branch and a head sha, losing the record would strand
 * the branch with nothing left to reap it.
 */
let cache: Map<string, StoredSession> | null = null;
/** Serialises writes so two concurrent saves cannot interleave. */
let writes: Promise<unknown> = Promise.resolve();

/** Guards against unbounded growth from repeated creates. */
const MAX_SESSIONS = 200;

const ID_ALPHABET = "abcdefghijkmnopqrstuvwxyz23456789";
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

async function load(): Promise<Map<string, StoredSession>> {
  if (cache) return cache;

  const loaded = new Map<string, StoredSession>();
  try {
    const parsed: unknown = JSON.parse(await readFile(storeFile(), "utf8"));
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        const session = validate(entry);
        if (session) loaded.set(session.id, session);
      }
    }
  } catch {
    // Missing or corrupt: start empty rather than refusing to boot. A corrupt
    // file is left on disk untouched until the next successful save.
  }

  cache = loaded;
  return loaded;
}

function validate(entry: unknown): StoredSession | null {
  if (!entry || typeof entry !== "object") return null;
  const value = entry as Record<string, unknown>;

  if (typeof value.id !== "string" || typeof value.key !== "string") return null;
  if (typeof value.name !== "string" || typeof value.joinCode !== "string") return null;
  if (typeof value.createdAt !== "number") return null;

  return {
    id: value.id,
    name: value.name,
    joinCode: value.joinCode,
    createdAt: value.createdAt,
    key: value.key,
    upstreamUrl: typeof value.upstreamUrl === "string" ? value.upstreamUrl : null,
    repo: (value.repo as SessionRepo | null | undefined) ?? null,
    // Records written before retention existed are treated as active now,
    // rather than as ancient and immediately reapable.
    lastActiveAt:
      typeof value.lastActiveAt === "number" ? value.lastActiveAt : Date.now(),
    pinned: value.pinned === true,
    archivedAt: typeof value.archivedAt === "number" ? value.archivedAt : null,
  };
}

async function save(): Promise<void> {
  const sessions = [...(cache?.values() ?? [])];
  const target = storeFile();

  writes = writes.then(async () => {
    await mkdir(dirname(target), { recursive: true });
    // Written aside and renamed so a crash mid-write cannot truncate the store.
    const temporary = `${target}.${randomString(6, ID_ALPHABET)}.tmp`;
    await writeFile(temporary, JSON.stringify(sessions, null, 2), "utf8");
    await rename(temporary, target);
  });

  await writes;
}

export type CreateOutcome =
  | { ok: true; session: StoredSession }
  | { ok: false; error: string };

export async function createSession(requestedName?: string): Promise<CreateOutcome> {
  const sessions = await load();

  if (sessions.size >= MAX_SESSIONS) {
    // Only unseeded sessions are disposable. A seeded one owns a repo, and
    // deleting somebody's code to make room is never the right default.
    const disposable = [...sessions.values()]
      .filter((session) => session.repo === null)
      .sort((a, b) => a.createdAt - b.createdAt)[0];

    if (!disposable) {
      return {
        ok: false,
        error: `The session limit of ${MAX_SESSIONS} is full and every session holds code. Idle sessions are reclaimed automatically; unpin one to let it through, or remove one by hand.`,
      };
    }
    sessions.delete(disposable.id);
  }

  const id = randomString(12, ID_ALPHABET);
  const session: StoredSession = {
    id,
    name: cleanName(requestedName) ?? `Session ${randomString(4, CODE_ALPHABET)}`,
    joinCode: `${randomString(4, CODE_ALPHABET)}-${randomString(4, CODE_ALPHABET)}`,
    key: randomBytes(32).toString("base64url"),
    createdAt: Date.now(),
    upstreamUrl: null,
    repo: null,
    lastActiveAt: Date.now(),
    pinned: false,
    archivedAt: null,
  };

  sessions.set(id, session);
  await save();
  return { ok: true, session };
}

export async function getSession(id: string): Promise<StoredSession | undefined> {
  return (await load()).get(id);
}

export async function listSessions(ids: string[]): Promise<StoredSession[]> {
  const sessions = await load();
  return ids
    .map((id) => sessions.get(id))
    .filter((session): session is StoredSession => session !== undefined)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function renameSession(
  id: string,
  name: string,
): Promise<StoredSession | undefined> {
  const session = (await load()).get(id);
  const cleaned = cleanName(name);
  if (!session || !cleaned) return undefined;

  session.name = cleaned;
  await save();
  return session;
}

/** Records the git state produced by a seed. */
export async function attachRepo(
  id: string,
  repo: SessionRepo,
  upstreamUrl: string | null,
): Promise<StoredSession | undefined> {
  const session = (await load()).get(id);
  if (!session) return undefined;

  session.repo = repo;
  session.upstreamUrl = upstreamUrl;
  await save();
  return session;
}

/** Advances HEAD after a commit. */
export async function setHeadSha(id: string, headSha: string): Promise<void> {
  const session = (await load()).get(id);
  if (!session?.repo) return;

  session.repo.headSha = headSha;
  await save();
}

/**
 * Marks a session as in use. Every repo read and write calls this, so idleness
 * means "nobody has opened it", not "nobody has committed to it".
 */
export async function touchSession(id: string): Promise<void> {
  const session = (await load()).get(id);
  if (!session) return;

  session.lastActiveAt = Date.now();
  // Opening an archived session un-archives it: the working copy is about to
  // be rebuilt anyway.
  session.archivedAt = null;
  await save();
}

/** Promotes a session to "keep", or releases it back to the retention rules. */
export async function setPinned(
  id: string,
  pinned: boolean,
): Promise<StoredSession | undefined> {
  const session = (await load()).get(id);
  if (!session) return undefined;

  session.pinned = pinned;
  await save();
  return session;
}

export async function markArchived(id: string): Promise<void> {
  const session = (await load()).get(id);
  if (!session) return;

  session.archivedAt = Date.now();
  await save();
}

export async function allSessions(): Promise<StoredSession[]> {
  return [...(await load()).values()];
}

/** Drops the record. The caller is responsible for the repo on disk. */
export async function deleteSession(id: string): Promise<void> {
  const sessions = await load();
  if (!sessions.delete(id)) return;
  await save();
}

/** Strips the secret before anything is sent to a browser. */
export function publicSession(session: StoredSession): Session {
  return {
    id: session.id,
    name: session.name,
    joinCode: session.joinCode,
    createdAt: session.createdAt,
    repo: session.repo,
    lastActiveAt: session.lastActiveAt,
    pinned: session.pinned,
    archivedAt: session.archivedAt,
  };
}

export function keyMatches(session: StoredSession, candidate: string | undefined): boolean {
  return !!candidate && constantTimeEquals(session.key, candidate);
}

export function joinCodeMatches(session: StoredSession, candidate: string): boolean {
  return constantTimeEquals(
    session.joinCode.toUpperCase(),
    candidate.trim().toUpperCase().replace(/\s+/g, ""),
  );
}

/** Avoids leaking how much of a secret was correct through response timing. */
function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function randomString(length: number, alphabet: string): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let index = 0; index < length; index += 1) {
    out += alphabet[bytes[index] % alphabet.length];
  }
  return out;
}

function cleanName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const trimmed = name.trim().replace(/\s+/g, " ").slice(0, 60);
  return trimmed.length > 0 ? trimmed : null;
}
