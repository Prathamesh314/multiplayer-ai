import { randomBytes } from "node:crypto";
import { isUniqueViolation, query, queryOne, transaction } from "../db/client";
import type { SessionRole } from "../session/types";
import type { Project, ProjectMember, ProjectRole } from "./types";
import { projectRoleToSessionRole } from "./types";

/**
 * Projects are the access boundary: you are added to a project, and that grants
 * every room inside it (migration 008). This module owns project creation, the
 * project roster, and — the load-bearing part — deriving what a caller may do
 * in a room from their project role, so no room keeps a roster of its own.
 *
 * An org owner/admin has an implicit 'admin' role on every project in the org,
 * even without an explicit project_members row: they created the org and must
 * never be locked out of its projects.
 */

type ProjectRow = {
  id: string;
  org_id: string;
  slug: string;
  name: string;
  source: "github" | "local";
  github_repo: string | null;
  default_branch: string | null;
  upstream_url: string | null;
  created_at: Date;
  archived_at: Date | null;
  my_role: ProjectRole;
};

const toProject = (row: ProjectRow): Project => ({
  id: row.id,
  orgId: row.org_id,
  slug: row.slug,
  name: row.name,
  source: row.source,
  githubRepo: row.github_repo,
  defaultBranch: row.default_branch,
  upstreamUrl: row.upstream_url,
  myRole: row.my_role,
  createdAt: row.created_at.getTime(),
  archivedAt: row.archived_at ? row.archived_at.getTime() : null,
});

function slugify(input: string): string {
  const base = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return base.length >= 1 ? base : `p-${randomBytes(3).toString("hex")}`;
}

export type CreateProjectInput = {
  orgId: string;
  createdBy: string;
  name: string;
  slug?: string;
  source?: "github" | "local";
  githubRepo?: string | null;
  defaultBranch?: string | null;
  upstreamUrl?: string | null;
};

export type CreateProjectResult =
  | { ok: true; project: Project }
  | { ok: false; error: string };

/**
 * Creates a project and makes its creator a project admin. The membership row
 * is written even though org owners have implicit admin — an explicit creator
 * on the roster reads better and survives a change to the implicit rule.
 */
export async function createProject(input: CreateProjectInput): Promise<CreateProjectResult> {
  const name = input.name.trim().replace(/\s+/g, " ").slice(0, 80);
  if (name.length === 0) return { ok: false, error: "Give the project a name." };

  const source = input.source ?? "local";
  if (source === "github" && !input.githubRepo) {
    return { ok: false, error: "Connect a GitHub repository first." };
  }

  let slug = slugify(input.slug ?? name);

  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const project = await transaction(async (tx) => {
        const inserted = await tx.query<Omit<ProjectRow, "my_role">>(
          `INSERT INTO projects
             (org_id, slug, name, source, github_repo, default_branch, upstream_url, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING id, org_id, slug, name, source, github_repo, default_branch,
                     upstream_url, created_at, archived_at`,
          [
            input.orgId,
            slug,
            name,
            source,
            input.githubRepo ?? null,
            input.defaultBranch ?? null,
            input.upstreamUrl ?? null,
            input.createdBy,
          ],
        );
        const row = inserted.rows[0];
        await tx.query(
          `INSERT INTO project_members (project_id, org_id, user_id, role, added_by)
           VALUES ($1, $2, $3, 'manager', $3)`,
          [row.id, input.orgId, input.createdBy],
        );
        return toProject({ ...row, my_role: "manager" });
      });
      return { ok: true, project };
    } catch (cause) {
      if (isUniqueViolation(cause, "projects_org_id_slug_key")) {
        if (input.slug) return { ok: false, error: "That project URL is already taken." };
        slug = `${slugify(name)}-${randomBytes(2).toString("hex")}`;
        continue;
      }
      throw cause;
    }
  }
  return { ok: false, error: "Could not allocate a URL for the project." };
}

/**
 * A single SQL fragment computing a caller's effective role on a project:
 * their explicit project_members role, or 'manager' if they own/administer the
 * org (org admins keep oversight of every project). NULL means no access.
 * Reused by every read below so the rule lives once.
 */
const EFFECTIVE_ROLE = `
  COALESCE(
    (SELECT pm.role FROM project_members pm
      WHERE pm.project_id = p.id AND pm.user_id = $USER AND pm.removed_at IS NULL),
    (SELECT 'manager' FROM org_members om
      WHERE om.org_id = p.org_id AND om.user_id = $USER
        AND om.status = 'active' AND om.role IN ('owner', 'admin'))
  )
`;

/** Projects in an org the caller can see (member of, or org admin). */
export async function listProjectsForUser(orgId: string, userId: string): Promise<Project[]> {
  const rows = await query<ProjectRow>(
    `SELECT p.id, p.org_id, p.slug, p.name, p.source, p.github_repo, p.default_branch,
            p.upstream_url, p.created_at, p.archived_at,
            ${EFFECTIVE_ROLE.replace(/\$USER/g, "$2")} AS my_role
       FROM projects p
      WHERE p.org_id = $1
        AND ${EFFECTIVE_ROLE.replace(/\$USER/g, "$2")} IS NOT NULL
      ORDER BY p.created_at`,
    [orgId, userId],
  );
  return rows.map(toProject);
}

/** One project by (org, slug), only if the caller can access it. */
export async function getProjectForUser(
  orgId: string,
  slug: string,
  userId: string,
): Promise<Project | null> {
  const row = await queryOne<ProjectRow>(
    `SELECT p.id, p.org_id, p.slug, p.name, p.source, p.github_repo, p.default_branch,
            p.upstream_url, p.created_at, p.archived_at,
            ${EFFECTIVE_ROLE.replace(/\$USER/g, "$3")} AS my_role
       FROM projects p
      WHERE p.org_id = $1 AND p.slug = $2
        AND ${EFFECTIVE_ROLE.replace(/\$USER/g, "$3")} IS NOT NULL`,
    [orgId, slug, userId],
  );
  return row ? toProject(row) : null;
}

/** The caller's effective project role, or null if they have none. */
export async function projectRoleOf(projectId: string, userId: string): Promise<ProjectRole | null> {
  const row = await queryOne<{ role: ProjectRole | null }>(
    `SELECT ${EFFECTIVE_ROLE.replace(/\$USER/g, "$2")} AS role
       FROM projects p WHERE p.id = $1`,
    [projectId, userId],
  );
  return row?.role ?? null;
}

/**
 * The room-access derivation everything hinges on: what may this user do in
 * this room *by virtue of the project*?
 *
 * Only a **public** room grants access this way — being on the project is
 * enough to drop in. A **private** room grants nothing here: its access lives
 * solely in the session_members roster, so getSession falls through to that.
 * A personal room (no project) also returns null and uses the roster.
 */
export async function roomRoleFromProject(
  sessionId: string,
  userId: string,
): Promise<SessionRole | null> {
  const row = await queryOne<{ role: ProjectRole | null }>(
    `SELECT ${EFFECTIVE_ROLE.replace(/\$USER/g, "$2")} AS role
       FROM sessions s
       JOIN projects p ON p.id = s.project_id
      WHERE s.id = $1 AND s.deleted_at IS NULL AND s.visibility = 'public'`,
    [sessionId, userId],
  );
  return row?.role ? projectRoleToSessionRole(row.role) : null;
}

/**
 * Rooms in a project the caller may actually see: every public room, plus the
 * private ones they are on the roster of. Managers additionally see the private
 * rooms they created (they are the room owner on its roster, so that is already
 * covered — no manager-wide peek into others' private rooms).
 */
export async function visibleRoomIds(projectId: string, userId: string): Promise<Set<string>> {
  const rows = await query<{ id: string }>(
    `SELECT s.id
       FROM sessions s
      WHERE s.project_id = $1 AND s.deleted_at IS NULL
        AND (
          s.visibility = 'public'
          OR EXISTS (
            SELECT 1 FROM session_members m
             WHERE m.session_id = s.id AND m.user_id = $2 AND m.removed_at IS NULL
          )
        )`,
    [projectId, userId],
  );
  return new Set(rows.map((r) => r.id));
}

// ---------------------------------------------------------------------------
// Roster
// ---------------------------------------------------------------------------

export async function listProjectMembers(projectId: string): Promise<ProjectMember[]> {
  const rows = await query<{
    user_id: string;
    handle: string;
    display_name: string;
    avatar_url: string | null;
    role: ProjectRole;
    joined_at: Date;
  }>(
    `SELECT pm.user_id, u.handle, u.display_name, u.avatar_url, pm.role, pm.joined_at
       FROM project_members pm
       JOIN users u ON u.id = pm.user_id
      WHERE pm.project_id = $1 AND pm.removed_at IS NULL
      ORDER BY pm.joined_at`,
    [projectId],
  );
  return rows.map((row) => ({
    userId: row.user_id,
    handle: row.handle,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    role: row.role,
    joinedAt: row.joined_at.getTime(),
  }));
}

/**
 * Adds an org member to a project. The composite foreign key refuses anyone who
 * is not already in the org, so a cross-tenant add fails in the database rather
 * than needing a check here.
 */
export async function addProjectMember(
  projectId: string,
  orgId: string,
  userId: string,
  role: ProjectRole,
  addedBy: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await query(
      `INSERT INTO project_members (project_id, org_id, user_id, role, added_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (project_id, user_id)
       DO UPDATE SET role = EXCLUDED.role, removed_at = NULL`,
      [projectId, orgId, userId, role, addedBy],
    );
    return { ok: true };
  } catch (cause) {
    if (isUniqueViolation(cause)) return { ok: false, error: "Already a member." };
    // A foreign-key violation here means "not in the org".
    const code = (cause as { code?: string }).code;
    if (code === "23503") return { ok: false, error: "That person is not in this organisation." };
    throw cause;
  }
}

export async function removeProjectMember(projectId: string, userId: string): Promise<void> {
  await query(
    `UPDATE project_members SET removed_at = now()
      WHERE project_id = $1 AND user_id = $2 AND removed_at IS NULL`,
    [projectId, userId],
  );
}
