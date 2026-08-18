import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { query, queryOne } from "../db/client";
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

/** Resolves the cookie to a user, or null. Also refreshes `last_used_at`. */
export async function currentUser(): Promise<CurrentUser | null> {
  const token = (await cookies()).get(COOKIE_NAME)?.value;
  if (!token) return null;

  const row = await queryOne<{
    id: string;
    handle: string;
    email: string;
    display_name: string;
    avatar_url: string | null;
    token_id: string;
  }>(
    `UPDATE auth_tokens t
        SET last_used_at = now()
       FROM users u
      WHERE t.token_hash = $1
        AND t.user_id = u.id
        AND t.revoked_at IS NULL
        AND t.expires_at > now()
        AND u.deleted_at IS NULL
  RETURNING u.id, u.handle, u.email, u.display_name, u.avatar_url, t.id AS token_id`,
    [digest(token)],
  );

  if (!row) return null;

  return {
    id: row.id,
    handle: row.handle,
    email: row.email,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
  };
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
