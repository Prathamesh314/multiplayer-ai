import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { query } from "../db/client";
import { userFromSessionToken } from "./session-token";
import type { CurrentUser } from "./types";

const COOKIE_NAME = "ma_auth";
const TOKEN_BYTES = 32;
const LIFETIME_DAYS = 30;

/**
 * The cookie holds the raw token; the database holds only its SHA-256. A dump
 * of auth_tokens therefore grants nothing — which is the entire reason the
 * column is a hash and not the token.
 *
 * SHA-256 with no salt is correct here, unlike for passwords: the input is 32
 * random bytes, so there is nothing to brute force.
 */
function digest(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

export async function issueToken(
  userId: string,
  meta: { userAgent?: string | null; ip?: string | null } = {},
): Promise<void> {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const expiresAt = new Date(Date.now() + LIFETIME_DAYS * 24 * 60 * 60 * 1000);

  await query(
    `INSERT INTO auth_tokens (user_id, token_hash, expires_at, user_agent, ip)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, digest(token), expiresAt, meta.userAgent ?? null, meta.ip ?? null],
  );

  (await cookies()).set(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
    secure: process.env.NODE_ENV === "production",
  });
}

/** Resolves the cookie with live revocation checks and throttled usage tracking. */
export async function currentUser(): Promise<CurrentUser | null> {
  return (await sessionUserResolver())();
}

/** Capture the cookie inside the request, then revalidate that exact token.
 * Redis callbacks run outside the subscriber's Next request context. Reading
 * cookies there can resolve another request's identity or throw entirely. */
export async function sessionUserResolver(): Promise<() => Promise<CurrentUser | null>> {
  const token = (await cookies()).get(COOKIE_NAME)?.value;
  return () => token ? userFromSessionToken(token) : Promise.resolve(null);
}

/** Revokes the current token and clears the cookie. */
export async function revokeToken(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(COOKIE_NAME)?.value;

  if (token) {
    await query(
      `UPDATE auth_tokens SET revoked_at = now()
        WHERE token_hash = $1 AND revoked_at IS NULL`,
      [digest(token)],
    );
  }

  jar.delete(COOKIE_NAME);
}

/** Signs every device out — the "sign out everywhere" the schema allows for. */
export async function revokeAllTokens(userId: string): Promise<void> {
  await query(
    `UPDATE auth_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId],
  );
}
