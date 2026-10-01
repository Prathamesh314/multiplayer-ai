import { createHash, randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { isUniqueViolation, query, queryOne, transaction } from "../db/client";
import type { Org, OrgMember, OrgRole, PendingInvitation } from "./types";

/**
 * Orgs live in Postgres (migrations 003–004). This module is the write side:
 * creating an org, managing its roster, and the two routes into it — an admin
 * pastes your connect code, or emails you a link. Both produce a *pending*
 * invitation, never a membership; acceptance is a separate, deliberate step.
 */

const RESERVED = new Set([
  "s", "api", "admin", "settings", "login", "signup", "new", "static", "_next", "o",
]);

const tokenDigest = (token: string) => createHash("sha256").update(token, "utf8").digest();

const INVITE_LIFETIME_DAYS = 14;

// ---------------------------------------------------------------------------
// Orgs
// ---------------------------------------------------------------------------

type OrgRow = {
  id: string;
  slug: string;
  name: string;
  image: string;
  created_at: Date;
  my_role: OrgRole;
};

const toOrg = (row: OrgRow): Org => ({
  id: row.id,
  slug: row.slug,
  name: row.name,
  myRole: row.my_role,
  image: row.image,
  createdAt: row.created_at.getTime(),
});

/** Turns a display name into a candidate slug. Uniqueness is settled on insert. */
function slugify(input: string): string {
  const base = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return base.length >= 2 ? base : `org-${randomBytes(3).toString("hex")}`;
}

export type CreateOrgResult =
  | { ok: true; org: Org }
  | { ok: false; error: string };

/**
 * Creates an org and makes the caller its owner, atomically — an ownerless org
 * is a state the deferred owner-guard trigger would reject anyway.
 *
 * The slug is retried on collision: the caller gave a name, not a slug, so a
 * clash is ours to resolve rather than theirs to see.
 */
export async function createOrg(
  userId: string,
  name: string,
  requestedSlug?: string,
): Promise<CreateOrgResult> {
  const cleanName = name.trim().replace(/\s+/g, " ").slice(0, 80);
  if (cleanName.length === 0) return { ok: false, error: "Give the organisation a name." };

  let slug = requestedSlug ? slugify(requestedSlug) : slugify(cleanName);
  if (RESERVED.has(slug)) slug = `${slug}-org`;

  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const org = await transaction(async (tx) => {
        const inserted = await tx.query<{ id: string; slug: string; name: string; image: string; created_at: Date }>(
          `INSERT INTO orgs (slug, name, created_by) VALUES ($1, $2, $3)
           RETURNING id, image, slug, name, created_at`,
          [slug, cleanName, userId],
        );
        const row = inserted.rows[0];
        await tx.query(
          `INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'owner')`,
          [row.id, userId],
        );
        return toOrg({ ...row, my_role: "owner" });
      });
      return { ok: true, org };
    } catch (cause) {
      if (isUniqueViolation(cause, "orgs_slug_key")) {
        // Append a short suffix and try again, unless the caller pinned a slug.
        if (requestedSlug) return { ok: false, error: "That URL is already taken." };
        slug = `${slugify(cleanName)}-${randomBytes(2).toString("hex")}`;
        continue;
      }
      throw cause;
    }
  }
  return { ok: false, error: "Could not allocate a URL for the organisation." };
}

/** Orgs this user is an active member of, for the sidebar rail. */
export async function listOrgsForUser(userId: string): Promise<Org[]> {
  const rows = await query<OrgRow>(
    `SELECT o.id, o.slug, o.name, o.image, o.created_at, m.role AS my_role
       FROM orgs o
       JOIN org_members m ON m.org_id = o.id
      WHERE m.user_id = $1 AND m.status = 'active' AND o.deleted_at IS NULL
      ORDER BY o.created_at`,
    [userId],
  );
  return rows.map(toOrg);
}

/** One org by slug, but only if the caller belongs to it. */
export async function getOrgForUser(slug: string, userId: string): Promise<Org | null> {
  const row = await queryOne<OrgRow>(
    `SELECT o.id, o.slug, o.name, o.created_at, m.role AS my_role
       FROM orgs o
       JOIN org_members m ON m.org_id = o.id
      WHERE o.slug = $1 AND m.user_id = $2 AND m.status = 'active' AND o.deleted_at IS NULL`,
    [slug, userId],
  );
  return row ? toOrg(row) : null;
}

export async function orgRoleOf(orgId: string, userId: string): Promise<OrgRole | null> {
  const row = await queryOne<{ role: OrgRole }>(
    `SELECT role FROM org_members
      WHERE org_id = $1 AND user_id = $2 AND status = 'active'`,
    [orgId, userId],
  );
  return row?.role ?? null;
}

export async function listOrgMembers(orgId: string): Promise<OrgMember[]> {
  const rows = await query<{
    user_id: string;
    handle: string;
    display_name: string;
    avatar_url: string | null;
    role: OrgRole;
    status: "active" | "suspended";
    joined_at: Date;
  }>(
    `SELECT m.user_id, u.handle, u.display_name, u.avatar_url, m.role, m.status, m.joined_at
       FROM org_members m
       JOIN users u ON u.id = m.user_id
      WHERE m.org_id = $1
      ORDER BY m.joined_at`,
    [orgId],
  );
  return rows.map((row) => ({
    userId: row.user_id,
    handle: row.handle,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    role: row.role,
    status: row.status,
    joinedAt: row.joined_at.getTime(),
  }));
}

/** One person's role and status, regardless of whether they're active — the
 * management path needs to see suspended members too, so it can't reuse
 * orgRoleOf (which is scoped to active members for access checks). */
export async function getOrgMembership(
  orgId: string,
  userId: string,
): Promise<{ role: OrgRole; status: "active" | "suspended" } | null> {
  return queryOne<{ role: OrgRole; status: "active" | "suspended" }>(
    `SELECT role, status FROM org_members WHERE org_id = $1 AND user_id = $2`,
    [orgId, userId],
  );
}

// The deferred "keep an owner" trigger surfaces as a check_violation; we turn it
// into a message the admin UI can show rather than a 500.
const KEEP_OWNER_ERROR = "An organisation must always keep at least one active owner.";
const isCheckViolation = (cause: unknown) => (cause as { code?: string }).code === "23514";

/** Authorization and the write share the org lock; a stale HTTP guard grants nothing. */
async function membershipChangeDenied(tx: PoolClient, orgId: string, actorId: string, targetId: string, nextRole?: OrgRole) {
  const { rows: orgs } = await tx.query(`SELECT id FROM orgs WHERE id=$1 AND deleted_at IS NULL FOR NO KEY UPDATE`, [orgId]);
  if (!orgs.length) return "This organisation is unavailable.";
  if (actorId === targetId) return "You can't change your own membership here.";
  const { rows } = await tx.query<{ user_id: string; role: OrgRole; status: string }>(
    `SELECT om.user_id, om.role, om.status FROM org_members om JOIN users u ON u.id=om.user_id
      WHERE om.org_id=$1 AND om.user_id=ANY($2::uuid[]) AND u.deleted_at IS NULL`, [orgId, [actorId, targetId]]);
  const actor = rows.find(row => row.user_id === actorId);
  const target = rows.find(row => row.user_id === targetId);
  if (!actor || actor.status !== "active" || !["owner", "admin"].includes(actor.role)) return "Only an active org admin can manage members.";
  if (!target) return "That person is not in this organisation.";
  if (actor.role !== "owner" && (target.role === "owner" || nextRole === "owner")) return "Only an owner can manage the owner role.";
  return null;
}

/**
 * Change a member's role and/or active status. The last-active-owner guard is
 * enforced by the database trigger; we translate its violation into a friendly
 * error. Returns false when there is no such membership to update.
 */
export async function updateOrgMember(
  orgId: string,
  userId: string,
  changes: { role?: OrgRole; status?: "active" | "suspended" },
  actorId: string,
): Promise<{ ok: true; updated: boolean } | { ok: false; error: string }> {
  const sets: string[] = [];
  const params: unknown[] = [orgId, userId];
  if (changes.role !== undefined) {
    params.push(changes.role);
    sets.push(`role = $${params.length}`);
  }
  if (changes.status !== undefined) {
    params.push(changes.status);
    sets.push(`status = $${params.length}`);
  }
  if (sets.length === 0) return { ok: true, updated: false };

  try {
    return await transaction(async tx => {
      const denied = await membershipChangeDenied(tx, orgId, actorId, userId, changes.role);
      if (denied) return { ok: false as const, error: denied };
      const { rows } = await tx.query<{ user_id: string }>(
        `UPDATE org_members SET ${sets.join(", ")}
          WHERE org_id = $1 AND user_id = $2
          RETURNING user_id`,
        params,
      );
      return { ok: true as const, updated: rows.length > 0 };
    });
  } catch (cause) {
    if (isCheckViolation(cause)) return { ok: false, error: KEEP_OWNER_ERROR };
    throw cause;
  }
}

/**
 * Remove someone from the org entirely. Cascades their team and project
 * memberships (composite foreign keys), and the keep-an-owner trigger backstops
 * removing the last owner.
 */
export async function removeOrgMember(
  orgId: string,
  userId: string,
  actorId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    return await transaction(async tx => {
      const denied = await membershipChangeDenied(tx, orgId, actorId, userId);
      if (denied) return { ok: false as const, error: denied };
      await tx.query(`DELETE FROM org_members WHERE org_id = $1 AND user_id = $2`, [orgId, userId]);
      return { ok: true as const };
    });
  } catch (cause) {
    if (isCheckViolation(cause)) return { ok: false, error: KEEP_OWNER_ERROR };
    throw cause;
  }
}

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

/**
 * Route one: an admin pastes a user's connect code. We resolve it to an account
 * and record a pending invitation aimed at them — not a membership. Sharing a
 * code says "you may ask me in", not "add me to anything".
 */
export type InviteResult =
  | { ok: true }
  | { ok: false; error: string };

export async function inviteByConnectCode(
  orgId: string,
  inviteeUserId: string,
  role: "admin" | "member",
  invitedBy: string,
): Promise<InviteResult> {
  const expiresAt = new Date(Date.now() + INVITE_LIFETIME_DAYS * 86_400_000);
  // Re-inviting supersedes any still-pending invite for this person, so it
  // never dead-ends on "already invited".
  return transaction(async (tx) => {
    await tx.query(
      `UPDATE org_invitations SET revoked_at = now()
        WHERE org_id = $1 AND via = 'connect_code' AND invitee_user_id = $2
          AND accepted_at IS NULL AND revoked_at IS NULL`,
      [orgId, inviteeUserId],
    );
    await tx.query(
      `INSERT INTO org_invitations (org_id, via, invitee_user_id, role, invited_by, expires_at)
       VALUES ($1, 'connect_code', $2, $3, $4, $5)`,
      [orgId, inviteeUserId, role, invitedBy, expiresAt],
    );
    return { ok: true as const };
  });
}

/**
 * Route two: an admin emails an invite. The token is returned once, here, to be
 * put in a link; only its hash is stored, like every other secret.
 */
export async function inviteByEmail(
  orgId: string,
  email: string,
  role: "admin" | "member",
  invitedBy: string,
): Promise<{ ok: true; token: string; expiresAt: number } | { ok: false; error: string }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + INVITE_LIFETIME_DAYS * 86_400_000);

  // A fresh link should always be issuable: any still-pending invite for this
  // email is superseded (its old token stops working), rather than blocking a
  // re-invite. Both steps run in one transaction so the live-invite unique
  // index never sees two at once.
  return transaction(async (tx) => {
    await tx.query(
      `UPDATE org_invitations SET revoked_at = now()
        WHERE org_id = $1 AND via = 'email' AND email = $2
          AND accepted_at IS NULL AND revoked_at IS NULL`,
      [orgId, email.trim()],
    );
    await tx.query(
      `INSERT INTO org_invitations (org_id, via, email, role, token_hash, invited_by, expires_at)
       VALUES ($1, 'email', $2, $3, $4, $5, $6)`,
      [orgId, email.trim(), role, tokenDigest(token), invitedBy, expiresAt],
    );
    return { ok: true as const, token, expiresAt: expiresAt.getTime() };
  });
}

/** Connect-code invitations awaiting this user's acceptance. */
export async function listPendingInvitations(userId: string): Promise<PendingInvitation[]> {
  const rows = await query<{
    id: string;
    org_id: string;
    org_name: string;
    org_slug: string;
    role: "admin" | "member";
    invited_by_name: string;
    created_at: Date;
    expires_at: Date;
  }>(
    `SELECT i.id, i.org_id, o.name AS org_name, o.slug AS org_slug, i.role,
            u.display_name AS invited_by_name, i.created_at, i.expires_at
       FROM org_invitations i
       JOIN orgs o ON o.id = i.org_id
       JOIN users u ON u.id = i.invited_by
      WHERE i.invitee_user_id = $1
        AND i.via = 'connect_code'
        AND i.accepted_at IS NULL AND i.revoked_at IS NULL
        AND i.expires_at > now()
      ORDER BY i.created_at DESC`,
    [userId],
  );
  return rows.map((row) => ({
    id: row.id,
    orgId: row.org_id,
    orgName: row.org_name,
    orgSlug: row.org_slug,
    role: row.role,
    invitedByName: row.invited_by_name,
    createdAt: row.created_at.getTime(),
    expiresAt: row.expires_at.getTime(),
  }));
}

/**
 * Accepts a connect-code invitation by id. The caller must be its named
 * invitee, checked in the same UPDATE that consumes it, and the membership is
 * created in the same transaction so a half-accepted state cannot be observed.
 */
export async function acceptInvitationById(
  invitationId: string,
  userId: string,
): Promise<{ ok: true; orgSlug: string } | { ok: false; error: string }> {
  return transaction(async (tx) => {
    const claimed = await tx.query<{ org_id: string; role: string }>(
      `UPDATE org_invitations
          SET accepted_at = now(), accepted_by = $2
        WHERE id = $1
          AND invitee_user_id = $2
          AND accepted_at IS NULL AND revoked_at IS NULL
          AND expires_at > now()
      RETURNING org_id, role`,
      [invitationId, userId],
    );
    if (claimed.rows.length === 0) {
      return { ok: false as const, error: "That invitation is no longer valid." };
    }
    const { org_id, role } = claimed.rows[0];
    await tx.query(
      `INSERT INTO org_members (org_id, user_id, role, invited_by)
       VALUES ($1, $2, $3, (SELECT invited_by FROM org_invitations WHERE id = $4))
       ON CONFLICT (org_id, user_id) DO UPDATE SET status = 'active'`,
      [org_id, userId, role, invitationId],
    );
    const slug = await tx.query<{ slug: string }>(`SELECT slug FROM orgs WHERE id = $1`, [org_id]);
    return { ok: true as const, orgSlug: slug.rows[0].slug };
  });
}

/**
 * Accepts an email invitation by its link token. The email on the invite is not
 * required to match the account's — following a private link is proof enough,
 * and matching it would block forwarding a seat to a teammate on another address.
 */
export async function acceptInvitationByToken(
  token: string,
  userId: string,
): Promise<{ ok: true; orgSlug: string } | { ok: false; error: string }> {
  return transaction(async (tx) => {
    const claimed = await tx.query<{ org_id: string; role: string }>(
      `UPDATE org_invitations
          SET accepted_at = now(), accepted_by = $2
        WHERE token_hash = $1
          AND via = 'email'
          AND accepted_at IS NULL AND revoked_at IS NULL
          AND expires_at > now()
      RETURNING org_id, role, invited_by`,
      [tokenDigest(token), userId],
    );
    if (claimed.rows.length === 0) {
      return { ok: false as const, error: "That invitation link is invalid or has expired." };
    }
    const { org_id, role } = claimed.rows[0];
    await tx.query(
      `INSERT INTO org_members (org_id, user_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (org_id, user_id) DO UPDATE SET status = 'active'`,
      [org_id, userId, role],
    );
    const slug = await tx.query<{ slug: string }>(`SELECT slug FROM orgs WHERE id = $1`, [org_id]);
    return { ok: true as const, orgSlug: slug.rows[0].slug };
  });
}


export async function updateOrgDetails(
  orgId: string,
  updates: { name?: string; image?: string | null },
): Promise<{ id: string; name: string; slug: string; image: string | null }> {
  const result = await query<{
    id: string;
    name: string;
    slug: string;
    image: string | null;
  }>(
    `UPDATE orgs
        SET name = COALESCE($2, name),
            image = CASE WHEN $3::boolean THEN $4 ELSE image END,
            updated_at = now()
      WHERE id = $1
    RETURNING id, name, slug, image`,
    [
      orgId,
      updates.name ?? null,
      updates.image !== undefined, // true when caller intends to update/clear image
      updates.image ?? null,
    ],
  );

  return result[0];
}
