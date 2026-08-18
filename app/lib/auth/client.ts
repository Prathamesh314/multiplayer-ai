import type { CurrentUser, MeResponse } from "./types";

async function readError(response: Response, fallback: string): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? fallback;
}

export async function fetchMe(): Promise<MeResponse> {
  const response = await fetch("/api/auth/me", { cache: "no-store" });
  if (!response.ok) return { user: null, connectCode: null };
  return (await response.json()) as MeResponse;
}

export async function register(input: {
  handle: string;
  email: string;
  displayName: string;
  password: string;
}): Promise<CurrentUser> {
  const response = await fetch("/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(await readError(response, "Could not create that account."));
  return ((await response.json()) as MeResponse).user!;
}

export async function login(identifier: string, password: string): Promise<CurrentUser> {
  const response = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier, password }),
  });
  if (!response.ok) throw new Error(await readError(response, "Could not sign you in."));
  return ((await response.json()) as MeResponse).user!;
}

export async function logout(): Promise<void> {
  await fetch("/api/auth/me", { method: "DELETE" });
}

export async function rotateConnectCode(): Promise<string | null> {
  const response = await fetch("/api/auth/me", { method: "POST" });
  if (!response.ok) throw new Error(await readError(response, "Could not rotate the code."));
  return ((await response.json()) as MeResponse).connectCode;
}
