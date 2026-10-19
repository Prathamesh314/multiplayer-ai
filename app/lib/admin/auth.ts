import { createHash, randomBytes } from "node:crypto";
import { query, queryOne } from "../db/client";
import { hashPassword, verifyPassword } from "../auth/password";
import { publicOrigin } from "../http/public-origin";

/*
 * Platform administrators sign in with an email and password of their own,
 * separate from Clerk (migration 065). The cookie holds a random token; only
 * its SHA-256 is stored. Sessions last 12 hours. Five wrong passwords lock the
 * account for 15 minutes, and every outcome is recorded for the dashboard.
 */

export const ADMIN_COOKIE = "mc_admin";
export const ADMIN_SESSION_HOURS = 12;
export const ADMIN_MIN_PASSWORD = 12;
const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

export type PlatformAdmin = { id: string; email: string; displayName: string; mustChangePassword: boolean; sessionId: string };

export class AdminAuthError extends Error {
  constructor(message: string, readonly status = 401) { super(message); }
}

const digest = (token: string) => createHash("sha256").update(token).digest();
// Compared against when the email is unknown, so a miss costs as long as a wrong password.
const DECOY = "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$" + "A".repeat(86) + "==";

async function record(action: string, adminId: string | null, email: string | null) {
  await query(`INSERT INTO platform_admin_events (admin_id, email, action) VALUES ($1, $2, $3)`, [adminId, email, action]);
}

/** Checks the password and opens a session; returns the cookie value. */
export async function signIn(email: string, password: string): Promise<{ token: string; expiresAt: Date; mustChangePassword: boolean }> {
  const normalized = email.trim().toLowerCase();
  const failure = new AdminAuthError("That email and password don't match an administrator.");
  if (!normalized || normalized.length > 320 || !password || password.length > 1024) throw failure;

  const admin = await queryOne<{ id: string; password_hash: string; must_change_password: boolean; locked_until: Date | null; disabled_at: Date | null }>(
    `SELECT id, password_hash, must_change_password, locked_until, disabled_at FROM platform_admins WHERE email = $1`, [normalized]);
  const matches = await verifyPassword(password, admin?.password_hash ?? DECOY);
  if (!admin || admin.disabled_at) {
    await record("login_failed", null, normalized);
    throw failure;
  }
  if (admin.locked_until && admin.locked_until > new Date()) {
    await record("login_failed", admin.id, normalized);
    throw new AdminAuthError(`Too many wrong passwords. Try again after ${admin.locked_until.toISOString().slice(11, 16)} UTC.`, 429);
  }
  if (!matches) {
    const updated = await queryOne<{ failed_attempts: number }>(
      `UPDATE platform_admins SET failed_attempts = failed_attempts + 1,
         locked_until = CASE WHEN failed_attempts + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END
       WHERE id = $1 RETURNING failed_attempts`, [admin.id, MAX_ATTEMPTS, LOCK_MINUTES]);
    await record((updated?.failed_attempts ?? 0) >= MAX_ATTEMPTS ? "locked" : "login_failed", admin.id, normalized);
    throw failure;
  }

  const token = randomBytes(32).toString("base64url");
  const session = await queryOne<{ expires_at: Date }>(
    `INSERT INTO platform_admin_sessions (admin_id, token_hash, expires_at) VALUES ($1, $2, now() + make_interval(hours => $3)) RETURNING expires_at`,
    [admin.id, digest(token), ADMIN_SESSION_HOURS]);
  await query(`UPDATE platform_admins SET failed_attempts = 0, locked_until = NULL, last_login_at = now() WHERE id = $1`, [admin.id]);
  await record("login", admin.id, normalized);
  return { token, expiresAt: session!.expires_at, mustChangePassword: admin.must_change_password };
}

/** The administrator a cookie value belongs to, or null when it is missing, expired or revoked. */
export async function adminForToken(token: string | undefined | null): Promise<PlatformAdmin | null> {
  if (!token || token.length > 128) return null;
  const row = await queryOne<{ id: string; email: string; display_name: string; must_change_password: boolean; session_id: string }>(
    `UPDATE platform_admin_sessions s SET last_seen_at = now()
       FROM platform_admins a
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND a.id = s.admin_id AND a.disabled_at IS NULL
      RETURNING a.id, a.email, a.display_name, a.must_change_password, s.id AS session_id`, [digest(token)]);
  return row ? { id: row.id, email: row.email, displayName: row.display_name, mustChangePassword: row.must_change_password, sessionId: row.session_id } : null;
}

export async function signOut(admin: PlatformAdmin) {
  await query(`UPDATE platform_admin_sessions SET revoked_at = now() WHERE id = $1`, [admin.sessionId]);
  await record("logout", admin.id, admin.email);
}

/** Replaces the password, keeps this session and ends every other one. */
export async function changePassword(admin: PlatformAdmin, current: string, next: string) {
  if (next.length < ADMIN_MIN_PASSWORD || next.length > 1024) throw new AdminAuthError(`Use at least ${ADMIN_MIN_PASSWORD} characters.`, 400);
  if (next === current) throw new AdminAuthError("Choose a password different from the current one.", 400);
  const row = await queryOne<{ password_hash: string }>(`SELECT password_hash FROM platform_admins WHERE id = $1`, [admin.id]);
  if (!row || !(await verifyPassword(current, row.password_hash))) throw new AdminAuthError("The current password is not correct.", 400);
  await query(`UPDATE platform_admins SET password_hash = $2, must_change_password = false, password_changed_at = now() WHERE id = $1`, [admin.id, await hashPassword(next)]);
  await query(`UPDATE platform_admin_sessions SET revoked_at = now() WHERE admin_id = $1 AND id <> $2 AND revoked_at IS NULL`, [admin.id, admin.sessionId]);
  await record("password_changed", admin.id, admin.email);
}

export function adminCookie(token: string, expiresAt: Date) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${ADMIN_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Expires=${expiresAt.toUTCString()}${secure}`;
}

export function clearedAdminCookie() {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${ADMIN_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`;
}

/** The cookie value from a request, for route handlers. */
export function adminToken(request: Request): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === ADMIN_COOKIE) return value.join("=");
  }
  return null;
}

/** Same-origin only: the admin forms post from this site, never from another. */
export function sameOrigin(request: Request): boolean {
  try { return request.headers.get("origin") === publicOrigin(request); } catch { return false; }
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try { const body = await request.json(); return body && typeof body === "object" ? body as Record<string, unknown> : {}; } catch { return {}; }
}
export { readJson as readAdminBody };

/** The signed-in administrator, for server components (reads the request cookie). */
export async function currentAdmin(): Promise<PlatformAdmin | null> {
  const { cookies } = await import("next/headers");
  return adminForToken((await cookies()).get(ADMIN_COOKIE)?.value);
}
