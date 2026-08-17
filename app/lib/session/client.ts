import type { Session, SessionListResponse } from "./types";

async function readError(response: Response, fallback: string): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? fallback;
}

export async function listMySessions(): Promise<Session[]> {
  const response = await fetch("/api/sessions", { cache: "no-store" });
  if (!response.ok) throw new Error(await readError(response, "Could not load your sessions."));
  return ((await response.json()) as SessionListResponse).sessions;
}

export async function createSession(name?: string): Promise<Session> {
  const response = await fetch("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!response.ok) throw new Error(await readError(response, "Could not create a session."));
  return (await response.json()) as Session;
}

export type SessionLoad =
  | { state: "ready"; session: Session }
  | { state: "locked"; reason: string };

export async function loadSession(id: string): Promise<SessionLoad> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(id)}`, { cache: "no-store" });

  if (response.status === 403) {
    return { state: "locked", reason: await readError(response, "This session is locked.") };
  }
  if (!response.ok) throw new Error(await readError(response, "Could not open this session."));

  return { state: "ready", session: (await response.json()) as Session };
}

export async function joinSession(id: string, code: string): Promise<Session> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
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

export async function leaveSession(id: string): Promise<void> {
  await fetch(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** Extracts a session id from a pasted URL, or returns the trimmed input. */
export function parseSessionId(input: string): string {
  const trimmed = input.trim();
  const fromUrl = /\/s\/([a-z0-9]+)/i.exec(trimmed);
  if (fromUrl) return fromUrl[1];
  return trimmed.replace(/^\/+|\/+$/g, "");
}
