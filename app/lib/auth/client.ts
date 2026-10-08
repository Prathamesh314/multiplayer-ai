import type { ContinueRequest, ContinueResponse, MeResponse, PasswordAuthResponse } from "./types";
import { isPasswordAuthResponse } from "./types";
import { authRequest } from "./request";
import type { useClerk } from "@clerk/nextjs";

async function readError(response: Response, fallback: string): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? fallback;
}

/** Compatibility client: sign in, verify an existing email, or continue registration. */
export async function continueWithEmail(input: ContinueRequest): Promise<ContinueResponse> {
  return authRequest("/api/auth/continue", "POST", input);
}

export async function fetchMe(): Promise<MeResponse> {
  const response = await fetch("/api/auth/me", { cache: "no-store" });
  if (!response.ok) return { user: null, connectCode: null };
  return (await response.json()) as MeResponse;
}

export async function register(input: {
  invitationToken?: string;
  handle?: string;
  email: string;
  displayName: string;
  password: string;
}): Promise<PasswordAuthResponse> {
  return authRequest("/api/auth/register", "POST", input, isPasswordAuthResponse);
}

export async function login(identifier: string, password: string): Promise<PasswordAuthResponse> {
  return authRequest("/api/auth/login", "POST", { identifier, password }, isPasswordAuthResponse);
}

export async function logout(): Promise<void> {
  const response = await fetch("/api/auth/me", { method: "DELETE" });
  if (!response.ok) throw new Error(await readError(response, "Could not sign out. Please try again."));
  await (window as Window & { Clerk?: Pick<ReturnType<typeof useClerk>, "signOut"> }).Clerk?.signOut();
}

export async function rotateConnectCode(): Promise<string | null> {
  const response = await fetch("/api/auth/me", { method: "POST" });
  if (!response.ok) throw new Error(await readError(response, "Could not rotate the code."));
  return ((await response.json()) as MeResponse).connectCode;
}
