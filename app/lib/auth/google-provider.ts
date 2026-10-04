import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export class GoogleAuthError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); }
}

export const authDigest = (value: string) => createHash("sha256").update(value).digest();
export const authSecretValid = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);

export function authOrigin() {
  let url: URL;
  try { url = new URL(process.env.AUTH_PUBLIC_URL ?? ""); }
  catch { throw new GoogleAuthError("Google sign-in is not configured on this server.", 503); }
  const local = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !local) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new GoogleAuthError("Configure AUTH_PUBLIC_URL as the public HTTPS origin.", 503);
  }
  return url.origin;
}

export function googleConfig() {
  const origin = authOrigin();
  let clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  let clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  const credentialsFile = process.env.GOOGLE_OAUTH_CREDENTIALS_FILE?.trim();
  if (credentialsFile) {
    // Accept Google's downloaded Web application JSON. Never take endpoint or
    // redirect URLs from this file, and never expose its contents in errors.
    try {
      const file = statSync(credentialsFile);
      if (!file.isFile() || file.size > 65536) throw new Error("Invalid credential file");
      const credentials = JSON.parse(readFileSync(credentialsFile, "utf8"))?.web;
      clientId = typeof credentials?.client_id === "string" ? credentials.client_id.trim() : "";
      clientSecret = typeof credentials?.client_secret === "string" ? credentials.client_secret.trim() : "";
    } catch {
      throw new GoogleAuthError("Google sign-in is not configured on this server.", 503);
    }
  }
  if (!clientId || !clientSecret) throw new GoogleAuthError("Google sign-in is not configured on this server.", 503);
  return { origin, clientId, clientSecret, redirectUri: `${origin}/api/auth/google/callback` };
}

export function googleConfigured() {
  try { googleConfig(); return true; } catch { return false; }
}

// One bounded key cache per process, shared across requests. The issuer and key
// endpoint are fixed; an OAuth response cannot supply its own signing key URL.
const googleKeys = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"), {
  timeoutDuration: 8000, cooldownDuration: 30000, cacheMaxAge: 3600000,
});

export type GoogleProfile = { subject: string; email: string; displayName: string };

export async function verifyGoogleToken(token: string, nonceHash: Buffer, clientId: string, keys: JWTVerifyGetKey = googleKeys): Promise<GoogleProfile> {
  const { payload } = await jwtVerify(token, keys, {
    algorithms: ["RS256"], issuer: ["https://accounts.google.com", "accounts.google.com"],
    audience: clientId, requiredClaims: ["sub", "exp", "iat", "nonce", "email", "email_verified"],
    maxTokenAge: "10m", clockTolerance: 30,
  });
  if (typeof payload.nonce !== "string" || !timingSafeEqual(authDigest(payload.nonce), nonceHash) ||
      (payload.azp !== undefined && payload.azp !== clientId) || payload.email_verified !== true ||
      typeof payload.email !== "string" || payload.email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(payload.email) ||
      typeof payload.sub !== "string" || !/^[\x21-\x7e]{1,255}$/.test(payload.sub)) {
    throw new GoogleAuthError("Google could not verify this account. Please try signing in again.");
  }
  return { subject: payload.sub, email: payload.email.trim(),
    displayName: typeof payload.name === "string" ? payload.name.trim().slice(0, 100) : "" };
}

export async function exchangeGoogleCode(code: string, verifier: string, nonceHash: Buffer): Promise<GoogleProfile> {
  const config = googleConfig();
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(10000), cache: "no-store",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, code_verifier: verifier, client_id: config.clientId,
      client_secret: config.clientSecret, redirect_uri: config.redirectUri, grant_type: "authorization_code" }),
  });
  if (!response.ok) throw new GoogleAuthError("Google sign-in could not be completed. Please try again.");
  const body = await response.json();
  if (typeof body.id_token !== "string" || body.id_token.length > 16384) throw new GoogleAuthError("Google returned an invalid sign-in response.");
  return verifyGoogleToken(body.id_token, nonceHash, config.clientId);
}
