import { currentTabId } from "../tab-id";
import { isJoinCode } from "./share";
import type {
  CreateShareLinkResponse,
  MembersResponse,
  Session,
  SessionListResponse,
  SessionMember,
  ShareLink,
  ShareLinksResponse,
  ShareRole,
} from "./types";

async function readError(response: Response, fallback: string): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? fallback;
}

/** Thrown when the server says "sign in first" rather than "you may not". */
export class NotSignedIn extends Error {
  constructor() {
    super("Sign in to continue.");
    this.name = "NotSignedIn";
  }
}

export async function listMySessions(): Promise<Session[]> {
  const response = await fetch("/api/sessions", { cache: "no-store" });
  if (response.status === 401) throw new NotSignedIn();
  if (!response.ok) throw new Error(await readError(response, "Could not load your sessions."));
  return ((await response.json()) as SessionListResponse).sessions;
}

export async function createSession(name?: string): Promise<Session> {
  const response = await fetch("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (response.status === 401) throw new NotSignedIn();
  if (!response.ok) throw new Error(await readError(response, "Could not create a session."));
  return (await response.json()) as Session;
}

export type SessionLoad =
  | { state: "ready"; session: Session }
  /** Signed in, but not on this session's roster. */
  | { state: "locked"; reason: string }
  /** Not signed in at all — a different problem, with a different fix. */
  | { state: "signin" };

export async function loadSession(id: string): Promise<SessionLoad> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(id)}`, { cache: "no-store" });

  if (response.status === 401) return { state: "signin" };
  if (response.status === 403) {
    return { state: "locked", reason: await readError(response, "This session is locked.") };
  }
  if (!response.ok) throw new Error(await readError(response, "Could not open this session."));

  return { state: "ready", session: (await response.json()) as Session };
}

/**
 * `secret` is either a generated link token or the short typed code; the shape
 * decides which field the server gets, and therefore what role is granted.
 */
export async function joinSession(id: string, secret: string): Promise<Session> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(isJoinCode(secret) ? { code: secret } : { token: secret }),
  });
  if (response.status === 401) throw new NotSignedIn();
  if (!response.ok) throw new Error(await readError(response, "Could not join that session."));
  return (await response.json()) as Session;
}

export async function renameSession(id: string, name: string): Promise<Session> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!response.ok) throw new Error(await readError(response, "Could not rename the session."));
  return (await response.json()) as Session;
}

export async function setPinned(id: string, pinned: boolean): Promise<Session> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pinned }),
  });
  if (!response.ok) throw new Error(await readError(response, "Could not update the session."));
  return (await response.json()) as Session;
}

export async function leaveSession(id: string): Promise<void> {
  await fetch(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** The roster, with live presence already folded in by the server. */
export async function fetchMembers(id: string): Promise<SessionMember[]> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/members`, {
    cache: "no-store",
  });
  if (!response.ok) return [];
  return ((await response.json()) as MembersResponse).members;
}

/** Extracts a session id from a pasted URL, or returns the trimmed input. */
export function parseSessionId(input: string): string {
  const trimmed = input.trim();
  const fromUrl = /\/s\/([a-z0-9]+)/i.exec(trimmed);
  if (fromUrl) return fromUrl[1];
  return trimmed.replace(/^\/+|\/+$/g, "").split("#")[0];
}


// ---------------------------------------------------------------------------
// Share links
// ---------------------------------------------------------------------------

export async function fetchShareLinks(id: string): Promise<ShareLink[]> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/links`, {
    cache: "no-store",
  });
  if (!response.ok) return [];
  return ((await response.json()) as ShareLinksResponse).links;
}

/** The token comes back once and is never recoverable; keep it or lose it. */
export async function createShareLink(
  id: string,
  role: ShareRole,
  options: { label?: string; expiresInDays?: number } = {},
): Promise<CreateShareLinkResponse> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/links`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ role, ...options }),
  });
  if (!response.ok) throw new Error(await readError(response, "Could not create a share link."));
  return (await response.json()) as CreateShareLinkResponse;
}

export async function revokeShareLink(id: string, linkId: string): Promise<void> {
  const response = await fetch(
    `/api/sessions/${encodeURIComponent(id)}/links?linkId=${encodeURIComponent(linkId)}`,
    { method: "DELETE" },
  );
  if (!response.ok) throw new Error(await readError(response, "Could not revoke that link."));
}


// ---------------------------------------------------------------------------
// Typing activity
// ---------------------------------------------------------------------------

/** Long enough not to flood, short enough that the badge never lapses. */
const ACTIVITY_THROTTLE_MS = 1500;

const lastPing = new Map<string, number>();

/**
 * Tells everyone else this account is typing in a file.
 *
 * Throttled per file and deliberately unawaited: it is a hint, and a dropped
 * one costs nothing because another follows and the badge expires by itself.
 */
export function notifyEditing(sessionId: string, path: string): void {
  const key = `${sessionId}:${path}`;
  const now = Date.now();
  if (now - (lastPing.get(key) ?? 0) < ACTIVITY_THROTTLE_MS) return;
  lastPing.set(key, now);

  void fetch(`/api/sessions/${encodeURIComponent(sessionId)}/activity`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, originId: currentTabId() }),
    keepalive: true,
  }).catch(() => {});
}
