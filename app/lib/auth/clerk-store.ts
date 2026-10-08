import type { UserJSON } from "@clerk/nextjs/server";
import { isUniqueViolation, query, queryOne, transaction } from "../db/client";
import { connectCode } from "../repo/users";
import { generatedHandle } from "./handle";
import { signupInvitation } from "./admission";
import { ClerkAccountError } from "./clerk-config";
import type { CurrentUser } from "./types";

type UserRow = { id: string; handle: string; email: string; display_name: string; avatar_url: string | null;
  clerk_user_id: string | null; clerk_updated_at: string | number; clerk_disabled_at: Date | null; deleted_at: Date | null };
const toUser = (row: UserRow): CurrentUser => ({ id: row.id, handle: row.handle, email: row.email, displayName: row.display_name, avatarUrl: row.avatar_url });

/** Only use a profile returned by Clerk's backend or its verified webhook. */
export function verifiedClerkProfile(profile: UserJSON) {
  const primary = profile.email_addresses.find(email => email.id === profile.primary_email_address_id);
  if (profile.banned || profile.locked) throw new ClerkAccountError("Your account is unavailable. Contact your workspace administrator.");
  if (!primary || primary.verification?.status !== "verified") {
    throw new ClerkAccountError("Verify your email in your account settings before opening the workspace.");
  }
  return { id: profile.id, email: primary.email_address.trim(), updatedAt: profile.updated_at,
    displayName: [profile.first_name, profile.last_name].filter(Boolean).join(" ").trim() || primary.email_address.split("@")[0],
    avatarUrl: profile.has_image ? profile.image_url : null };
}

export async function userForClerkSession(clerkUserId: string, sessionId: string): Promise<CurrentUser | null> {
  const row = await queryOne<UserRow>(`SELECT u.* FROM users u WHERE u.clerk_user_id=$1
    AND u.deleted_at IS NULL AND u.clerk_disabled_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM clerk_revoked_sessions WHERE session_id=$2)`, [clerkUserId, sessionId]);
  return row ? toUser(row) : null;
}

/** Provision once after Clerk sign-in. No provider calls while a DB lock is held.
 * Matching a verified address preserves the UUID of a pre-Clerk account, but can
 * never relink a deleted account or one already bound to another Clerk subject. */
export async function completeClerkAccount(profile: UserJSON, invitationToken?: string): Promise<CurrentUser> {
  const identity = verifiedClerkProfile(profile);
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await transaction(async tx => {
        // Serialize only this identity/email, including the no-row creation race.
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["clerk:" + identity.id]);
        if ((await tx.query("SELECT 1 FROM clerk_deleted_users WHERE clerk_user_id=$1", [identity.id])).rows.length) {
          throw new ClerkAccountError("This account has been deleted. Please sign in with an active account.");
        }
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["clerk-email:" + identity.email.toLowerCase()]);
        const existing = (await tx.query<UserRow>(`SELECT * FROM users WHERE clerk_user_id=$1 OR email=$2 ORDER BY id FOR UPDATE`, [identity.id, identity.email])).rows;
        const linked = existing.find(row => row.clerk_user_id === identity.id);
        const row = linked ?? existing[0];
        if (row?.deleted_at || (row?.clerk_user_id && row.clerk_user_id !== identity.id) || existing.length > 1) {
          throw new ClerkAccountError("This email is already associated with another workspace account. Contact your workspace administrator.");
        }
        if (row) {
          if (row.clerk_disabled_at && Number(row.clerk_updated_at) >= identity.updatedAt) throw new ClerkAccountError("Your account is unavailable. Contact your workspace administrator.");
          if (linked && Number(row.clerk_updated_at) > identity.updatedAt) return toUser(row);
          const result = await tx.query<UserRow>(`UPDATE users SET clerk_user_id=$2, email=$3, email_verified_at=COALESCE(email_verified_at,now()),
            display_name=$4, avatar_url=$5, clerk_disabled_at=NULL, clerk_updated_at=GREATEST(clerk_updated_at,$6) WHERE id=$1 RETURNING *`,
          [row.id, identity.id, identity.email, identity.displayName, identity.avatarUrl, identity.updatedAt]);
          return toUser(result.rows[0]);
        }
        const invitation = await signupInvitation(identity.email, invitationToken, tx);
        const result = await tx.query<UserRow>(`INSERT INTO users(handle,email,display_name,avatar_url,connect_code,email_verified_at,clerk_user_id,clerk_updated_at)
          VALUES($1,$2,$3,$4,$5,now(),$6,$7) RETURNING *`,
        [generatedHandle(identity.displayName, identity.email), identity.email, identity.displayName, identity.avatarUrl, connectCode(), identity.id, identity.updatedAt]);
        const user = result.rows[0];
        if (invitation?.kind === "beta") await tx.query("UPDATE signup_invitations SET used_at=now(),used_by=$2 WHERE id=$1", [invitation.id, user.id]);
        if (invitation?.kind === "org") await tx.query("UPDATE org_invitations SET signup_user_id=$2 WHERE id=$1", [invitation.id, user.id]);
        return toUser(user);
      });
    } catch (cause) {
      if (isUniqueViolation(cause) && attempt < 4) continue;
      throw cause;
    }
  }
  throw new ClerkAccountError("Could not finish setting up your workspace account. Please try again.", 503);
}

/** Webhooks update already-linked identities. They never grant signup or project
 * access, and old/duplicate events cannot undo a newer profile or deletion. */
export async function syncClerkProfile(profile: UserJSON) {
  let identity;
  try { identity = verifiedClerkProfile(profile); }
  catch (cause) {
    if (!(cause instanceof ClerkAccountError)) throw cause;
    await query(`UPDATE users SET clerk_disabled_at=now(),clerk_updated_at=$2
      WHERE clerk_user_id=$1 AND clerk_updated_at<$2 AND deleted_at IS NULL`, [profile.id, profile.updated_at]);
    return;
  }
  await query(`UPDATE users SET email=$2,display_name=$3,avatar_url=$4,email_verified_at=COALESCE(email_verified_at,now()),clerk_updated_at=$5,clerk_disabled_at=NULL
    WHERE clerk_user_id=$1 AND clerk_updated_at<$5 AND deleted_at IS NULL`,
  [identity.id, identity.email, identity.displayName, identity.avatarUrl, identity.updatedAt]);
}

export async function deleteClerkAccount(clerkUserId: string) {
  await transaction(async tx => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["clerk:" + clerkUserId]);
    await tx.query("INSERT INTO clerk_deleted_users(clerk_user_id) VALUES($1) ON CONFLICT DO NOTHING", [clerkUserId]);
    const result = await tx.query<{ id: string }>(`UPDATE users SET deleted_at=COALESCE(deleted_at,now()),clerk_disabled_at=now()
      WHERE clerk_user_id=$1 RETURNING id`, [clerkUserId]);
    if (result.rows[0]) await tx.query("UPDATE runner_devices SET revoked_at=COALESCE(revoked_at,now()) WHERE user_id=$1", [result.rows[0].id]);
  });
}

export async function recordClerkRevocation(sessionId: string) {
  await query("INSERT INTO clerk_revoked_sessions(session_id) VALUES($1) ON CONFLICT DO NOTHING", [sessionId]);
}
