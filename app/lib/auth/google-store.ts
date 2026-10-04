import { randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { isUniqueViolation, query, queryOne, transaction } from "../db/client";
import { connectCode } from "../repo/users";
import { SignupAdmissionError, signupInvitationHash } from "./admission";
import { generatedHandle } from "./handle";
import { verifyPassword } from "./password";
import { safeReturnPath } from "./return-path";
import { authDigest, authSecretValid, googleConfig, GoogleAuthError, type GoogleProfile } from "./google-provider";
import type { CurrentUser } from "./types";

export const GOOGLE_FLOW_SECONDS = 600;
const expired = () => new GoogleAuthError("This Google sign-in has expired or was already used. Start again.", 409);
const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
type Flow = {
  token_hash: Buffer; nonce_hash: Buffer; code_verifier: string | null; invitation_hash: Buffer | null;
  return_path: string; desktop_id: string | null; google_subject: string; email: string; display_name: string;
};
type UserRow = { id: string; handle: string; email: string; display_name: string; avatar_url: string | null; deleted_at: Date | null; password_hash: string | null };
const toUser = (user: UserRow): CurrentUser => ({ id: user.id, handle: user.handle, email: user.email, displayName: user.display_name, avatarUrl: user.avatar_url });
async function cleanExpired() {
  await query("DELETE FROM google_auth_flows WHERE expires_at < now()");
  await query("DELETE FROM google_desktop_signins WHERE expires_at < now()");
}

export async function beginGoogleAuth(input: { invitationToken?: unknown; next?: string; desktopId?: string | null }, previousToken?: string) {
  const config = googleConfig();
  await cleanExpired();
  if (input.desktopId && (!uuid(input.desktopId) || !await queryOne("SELECT id FROM google_desktop_signins WHERE id=$1 AND user_id IS NULL AND expires_at>now()", [input.desktopId]))) throw expired();
  const token = randomBytes(32).toString("base64url"), state = randomBytes(32).toString("base64url");
  const nonce = randomBytes(32).toString("base64url"), verifier = randomBytes(32).toString("base64url");
  const previous = authSecretValid(previousToken) ? await queryOne<{ invitation_hash: Buffer | null }>("SELECT invitation_hash FROM google_auth_flows WHERE token_hash=$1 AND expires_at>now()", [authDigest(previousToken)]) : null;
  await query(`INSERT INTO google_auth_flows(token_hash,state_hash,nonce_hash,code_verifier,invitation_hash,return_path,desktop_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7)`, [authDigest(token), authDigest(state), authDigest(nonce), verifier,
    authSecretValid(input.invitationToken) ? authDigest(input.invitationToken) : previous?.invitation_hash ?? null, safeReturnPath(input.next), input.desktopId || null]);
  if (authSecretValid(previousToken)) await query("DELETE FROM google_auth_flows WHERE token_hash=$1", [authDigest(previousToken)]);
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri,
    response_type: "code", scope: "openid email profile", state, nonce, prompt: "select_account",
    code_challenge: authDigest(verifier).toString("base64url"), code_challenge_method: "S256" }).toString();
  return { token, url: url.href };
}

/** Atomic claim before talking to Google: callback replay and cross-browser callbacks fail closed. */
export async function claimGoogleCallback(token: string | undefined, state: string | null) {
  if (!authSecretValid(token) || !authSecretValid(state)) throw expired();
  const flow = await queryOne<Flow>(`UPDATE google_auth_flows SET stage='exchanging'
    WHERE token_hash=$1 AND state_hash=$2 AND stage='pending' AND expires_at>now() RETURNING *`, [authDigest(token), authDigest(state)]);
  if (!flow || !flow.code_verifier) throw expired();
  return flow;
}

export async function saveGoogleProfile(token: string, profile: GoogleProfile) {
  const row = await queryOne(`UPDATE google_auth_flows SET stage='verified',code_verifier=NULL,google_subject=$2,email=$3,display_name=$4
    WHERE token_hash=$1 AND stage='exchanging' AND expires_at>now() RETURNING token_hash`,
    [authDigest(token), profile.subject, profile.email, profile.displayName]);
  if (!row) throw expired();
}

async function identityUser(subject: string, tx: PoolClient) {
  return (await tx.query<UserRow>(`SELECT u.* FROM user_identities i JOIN users u ON u.id=i.user_id
    WHERE i.provider='google' AND i.provider_user_id=$1 FOR UPDATE OF u`, [subject])).rows[0];
}

export async function pendingGoogleProfile(token?: string) {
  if (!authSecretValid(token)) return null;
  const flow = await queryOne<Flow>("SELECT * FROM google_auth_flows WHERE token_hash=$1 AND stage='verified' AND expires_at>now()", [authDigest(token)]);
  if (!flow) return null;
  const identity = await queryOne<{ id: string; deleted_at: Date | null }>(`SELECT u.id,u.deleted_at FROM user_identities i JOIN users u ON u.id=i.user_id WHERE i.provider='google' AND i.provider_user_id=$1`, [flow.google_subject]);
  const existing = identity ?? await queryOne<{ id: string; deleted_at: Date | null }>("SELECT id,deleted_at FROM users WHERE email=$1", [flow.email]);
  return { email: flow.email, displayName: flow.display_name, next: flow.return_path,
    mode: identity ? "signin" as const : existing ? "link" as const : "signup" as const,
    unavailable: !!existing?.deleted_at, desktop: !!flow.desktop_id, desktopId: flow.desktop_id,
    desktopCode: flow.desktop_id?.slice(0, 8).toUpperCase() ?? null };
}

/** Returning Google identities can sign in without admitting new users or matching mutable email addresses. */
export async function finishExistingGoogleAuth(token: string) {
  return transaction(async tx => {
    const flow = (await tx.query<Flow>("SELECT * FROM google_auth_flows WHERE token_hash=$1 AND stage='verified' AND expires_at>now() FOR UPDATE", [authDigest(token)])).rows[0];
    if (!flow || flow.desktop_id) return null; // Desktop approval always needs an explicit confirmation.
    const user = await identityUser(flow.google_subject, tx);
    if (!user) return null;
    if (user.deleted_at) throw new GoogleAuthError("This account is unavailable.", 403);
    await tx.query("DELETE FROM google_auth_flows WHERE token_hash=$1", [flow.token_hash]);
    return { user: toUser(user), next: flow.return_path };
  });
}

type GoogleCompletionInput = { handle?: unknown; password?: unknown; invitationToken?: unknown };

/** New browser accounts enter immediately; linking and desktop approval remain explicit. */
export async function finishGoogleBrowserAuth(token: string) {
  return finishGoogleAuth(token, {}, true);
}

export async function completeGoogleAuth(token: string | undefined, input: GoogleCompletionInput) {
  const result = await finishGoogleAuth(token, input, false);
  if (!result) throw expired();
  return result;
}

async function finishGoogleAuth(token: string | undefined, input: GoogleCompletionInput, automatic: boolean) {
  if (!authSecretValid(token)) throw expired();
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await transaction(async tx => {
        const flow = (await tx.query<Flow>("SELECT * FROM google_auth_flows WHERE token_hash=$1 AND stage='verified' AND expires_at>now() FOR UPDATE", [authDigest(token)])).rows[0];
        if (!flow) throw expired();
        if (automatic && flow.desktop_id) return null;
        let user = await identityUser(flow.google_subject, tx);
        if (!user) {
          user = (await tx.query<UserRow>("SELECT * FROM users WHERE email=$1 FOR UPDATE", [flow.email])).rows[0];
          if (user) {
            if (automatic) return null;
            // Never silently attach a provider to an account just because emails match.
            if (user.deleted_at) throw new GoogleAuthError("This account is unavailable.", 403);
            if (!user.password_hash || typeof input.password !== "string" || input.password.length > 200 || !await verifyPassword(input.password, user.password_hash)) {
              throw new GoogleAuthError("Enter your existing account password to link Google. Otherwise, use your original sign-in method.", 401);
            }
            if ((await tx.query("SELECT id FROM user_identities WHERE user_id=$1 AND provider='google'", [user.id])).rows[0]) {
              throw new GoogleAuthError("This account is already linked to a different Google account.", 409);
            }
          } else {
            const handle = input.handle === undefined ? generatedHandle(flow.display_name, flow.email) : typeof input.handle === "string" ? input.handle.trim().toLowerCase() : "";
            if (!/^[a-z0-9][a-z0-9_-]{1,38}$/.test(handle)) throw new GoogleAuthError("Use 2–39 characters: lowercase letters, numbers, dashes or underscores.");
            const invitationHash = authSecretValid(input.invitationToken) ? authDigest(input.invitationToken) : flow.invitation_hash;
            const invitation = await signupInvitationHash(flow.email, invitationHash, tx);
            user = (await tx.query<UserRow>(`INSERT INTO users(handle,email,display_name,email_verified_at,connect_code)
              VALUES ($1,$2,$3,now(),$4) RETURNING *`, [handle, flow.email, flow.display_name || handle, connectCode()])).rows[0];
            if (invitation?.kind === "beta") await tx.query("UPDATE signup_invitations SET used_at=now(),used_by=$2 WHERE id=$1", [invitation.id, user.id]);
            if (invitation?.kind === "org") await tx.query("UPDATE org_invitations SET signup_user_id=$2 WHERE id=$1", [invitation.id, user.id]);
          }
          await tx.query("INSERT INTO user_identities(user_id,provider,provider_user_id) VALUES ($1,'google',$2)", [user.id, flow.google_subject]);
        }
        if (user.deleted_at) throw new GoogleAuthError("This account is unavailable.", 403);
        if (flow.desktop_id) {
          const approved = await tx.query("UPDATE google_desktop_signins SET user_id=$2 WHERE id=$1 AND user_id IS NULL AND expires_at>now() RETURNING id", [flow.desktop_id, user.id]);
          if (!approved.rows[0]) throw expired();
        }
        await tx.query("DELETE FROM google_auth_flows WHERE token_hash=$1", [flow.token_hash]);
        return { user: toUser(user), next: flow.desktop_id ? "/login?google=desktop-done" : flow.return_path };
      });
    } catch (cause) {
      if (automatic && cause instanceof SignupAdmissionError) return null;
      if (attempt < 4 && (isUniqueViolation(cause, "users_connect_code_key") || (input.handle === undefined && isUniqueViolation(cause, "users_handle_key")))) continue;
      if (isUniqueViolation(cause, "users_handle_key")) throw new GoogleAuthError("That username is taken. Choose another.", 409);
      if (isUniqueViolation(cause)) throw new GoogleAuthError("This account changed during signup. Please try Google sign-in again.", 409);
      throw cause;
    }
  }
  throw new GoogleAuthError("Could not create your account. Please try again.", 409);
}

export async function createGoogleDesktopSignin(challenge: unknown) {
  googleConfig();
  if (!authSecretValid(challenge)) throw new GoogleAuthError("Invalid desktop sign-in request.");
  await cleanExpired();
  const row = await queryOne<{ id: string }>("INSERT INTO google_desktop_signins(challenge) VALUES ($1) RETURNING id", [challenge]);
  return { id: row!.id, code: row!.id.slice(0, 8).toUpperCase() };
}

export async function redeemGoogleDesktopSignin(id: unknown, verifier: unknown) {
  if (!uuid(id) || !authSecretValid(verifier)) throw expired();
  return transaction(async tx => {
    const row = (await tx.query<{ user_id: string | null }>(`SELECT user_id FROM google_desktop_signins
      WHERE id=$1 AND challenge=$2 AND expires_at>now() FOR UPDATE`, [id, authDigest(verifier).toString("base64url")])).rows[0];
    if (!row) throw expired();
    if (!row.user_id) throw new GoogleAuthError("Finish Google sign-in in your browser first, then try again.", 409);
    const user = (await tx.query<UserRow>("SELECT * FROM users WHERE id=$1 AND deleted_at IS NULL FOR UPDATE", [row.user_id])).rows[0];
    if (!user) throw new GoogleAuthError("This account is unavailable.", 403);
    await tx.query("DELETE FROM google_desktop_signins WHERE id=$1", [id]);
    return toUser(user);
  });
}
