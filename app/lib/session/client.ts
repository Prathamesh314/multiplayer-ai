import { currentTabId } from "../tab-id";
import { isJoinCode } from "./share";
import type {
  ChatMessage,
  CreateShareLinkResponse,
  MembersResponse,
  Session,
  SessionListResponse,
  SessionMember,
  ShareLink,
  MessagesResponse,
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

/** Outcome of a publish or sync: the new sha, or the files that conflicted. */
export type MergeOutcome =
  | { ok: true; sha: string }
  | { ok: false; reason: "conflict"; files: string[] };

/** Merge this room's work back into the project's shared main. */
export async function publishRoom(id: string): Promise<MergeOutcome> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/publish`, { method: "POST" });
  if (response.status === 409) return (await response.json()) as MergeOutcome;
  if (!response.ok) throw new Error(await readError(response, "Could not publish to the project."));
  return (await response.json()) as MergeOutcome;
}

/** Pull the project's latest main into this room. */
export async function syncRoom(id: string): Promise<MergeOutcome> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/sync`, { method: "POST" });
  if (response.status === 409) return (await response.json()) as MergeOutcome;
  if (!response.ok) throw new Error(await readError(response, "Could not sync from the project."));
  return (await response.json()) as MergeOutcome;
}

/** Flip a room between public (open to the project) and private (invite-only). */
export async function setRoomVisibility(
  id: string,
  visibility: "public" | "private",
): Promise<Session> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ visibility }),
  });
  if (!response.ok) throw new Error(await readError(response, "Could not change room visibility."));
  return (await response.json()) as Session;
}

/** Add a project member to a room's roster (how people get into a private room). */
export async function addRoomMember(
  id: string,
  userId: string,
  role: "editor" | "viewer" = "editor",
): Promise<void> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/members`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId, role }),
  });
  if (!response.ok) throw new Error(await readError(response, "Could not add that person."));
}

export async function removeRoomMember(id: string, userId: string): Promise<void> {
  const response = await fetch(
    `/api/sessions/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`,
    { method: "DELETE" },
  );
  if (!response.ok) throw new Error(await readError(response, "Could not remove that person."));
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

type Pending = { repoId: string | null; path: string; line: number; column: number };

const lastPing = new Map<string, number>();
const trailing = new Map<string, { timer: ReturnType<typeof setTimeout>; pending: Pending }>();

function send(sessionId: string, at: Pending): void {
  lastPing.set(sessionId, Date.now());
  void fetch(`/api/sessions/${encodeURIComponent(sessionId)}/activity?repoId=${encodeURIComponent(at.repoId ?? "")}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...at, originId: currentTabId() }),
    keepalive: true,
  }).catch(() => {});
}

/**
 * Tells everyone else where this account is working: which file, and where the
 * caret sits in it.
 *
 * Leading-and-trailing throttle. Leading so the marker appears the moment
 * someone starts, trailing so where they *stopped* is what everyone ends up
 * seeing — a plain throttle would leave the marker frozen at whatever position
 * happened to fall on the last tick.
 */
export function notifyEditing(
  sessionId: string,
  path: string,
  line = 1,
  column = 1,
  repoId: string | null = null,
): void {
  const at: Pending = { path, line, column, repoId };
  const since = Date.now() - (lastPing.get(sessionId) ?? 0);

  if (since >= ACTIVITY_THROTTLE_MS) {
    const queued = trailing.get(sessionId);
    if (queued) {
      clearTimeout(queued.timer);
      trailing.delete(sessionId);
    }
    send(sessionId, at);
    return;
  }

  const queued = trailing.get(sessionId);
  if (queued) {
    queued.pending = at;
    return;
  }

  const timer = setTimeout(() => {
    const entry = trailing.get(sessionId);
    trailing.delete(sessionId);
    if (entry) send(sessionId, entry.pending);
  }, ACTIVITY_THROTTLE_MS - since);

  trailing.set(sessionId, { timer, pending: at });
}


// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

export async function fetchMessages(id: string, before?: string): Promise<MessagesResponse> {
  const query = before ? `?before=${encodeURIComponent(before)}` : "";
  const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/messages${query}`, {
    cache: "no-store",
  });
  if (!response.ok) return { messages: [], hasMore: false };
  return (await response.json()) as MessagesResponse;
}

export async function sendMessage(id: string, body: string): Promise<ChatMessage> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body }),
  });
  if (!response.ok) throw new Error(await readError(response, "Could not send that message."));
  return (await response.json()) as ChatMessage;
}
