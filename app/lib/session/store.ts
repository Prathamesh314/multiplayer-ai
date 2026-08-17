import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Session } from "./types";

type StoredSession = Session & {
  /** Secret held only in the creator's cookie — never sent in a URL. */
  key: string;
};

/**
 * Sessions live in memory: they are gone when the server restarts. That is
 * deliberate for now — this is the scaffolding for a real store, not a
 * substitute for one.
 */
const sessions = new Map<string, StoredSession>();

/** Guards against unbounded growth from repeated creates. */
const MAX_SESSIONS = 200;

const ID_ALPHABET = "abcdefghijkmnopqrstuvwxyz23456789";
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function createSession(requestedName?: string): StoredSession {
  if (sessions.size >= MAX_SESSIONS) {
    // Drop the oldest so a long-running dev server keeps working.
    const oldest = [...sessions.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
    if (oldest) sessions.delete(oldest.id);
  }

  const id = randomString(12, ID_ALPHABET);
  const session: StoredSession = {
    id,
    name: cleanName(requestedName) ?? `Session ${randomString(4, CODE_ALPHABET)}`,
    joinCode: `${randomString(4, CODE_ALPHABET)}-${randomString(4, CODE_ALPHABET)}`,
    key: randomBytes(32).toString("base64url"),
    createdAt: Date.now(),
  };

  sessions.set(id, session);
  return session;
}

export function getSession(id: string): StoredSession | undefined {
  return sessions.get(id);
}

export function listSessions(ids: string[]): StoredSession[] {
  return ids
    .map((id) => sessions.get(id))
    .filter((session): session is StoredSession => session !== undefined)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function renameSession(id: string, name: string): StoredSession | undefined {
  const session = sessions.get(id);
  const cleaned = cleanName(name);
  if (!session || !cleaned) return undefined;
  session.name = cleaned;
  return session;
}

/** Strips the secret before anything is sent to a browser. */
export function publicSession(session: StoredSession): Session {
  return {
    id: session.id,
    name: session.name,
    joinCode: session.joinCode,
    createdAt: session.createdAt,
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
