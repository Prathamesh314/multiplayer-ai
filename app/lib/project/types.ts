import type { SessionRole } from "../session/types";

/**
 * A project's own role scheme, distinct from the room-level SessionRole.
 * 'manager' is the "Project Manager" — runs the project and its roster without
 * needing to be an org admin.
 */
export type ProjectRole = "manager" | "editor" | "viewer";

export const canManageProject = (role: ProjectRole | null | undefined): boolean =>
  role === "manager";

/**
 * How a project role maps onto what someone can do in a *public* room. Access
 * to a private room comes from its own roster, not this translation.
 */
export function projectRoleToSessionRole(role: ProjectRole): SessionRole {
  switch (role) {
    case "manager":
      return "owner";
    case "editor":
      return "editor";
    case "viewer":
      return "viewer";
  }
}

export type Project = {
  id: string;
  orgId: string;
  slug: string;
  name: string;
  source: "github" | "local";
  githubRepo: string | null;
  defaultBranch: string | null;
  upstreamUrl: string | null;
  /** The requesting account's effective role, for gating. */
  myRole: ProjectRole;
  createdAt: number;
  archivedAt: number | null;
};

export type ProjectMember = {
  userId: string;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  role: ProjectRole;
  joinedAt: number;
};

export type ProjectListResponse = { projects: Project[] };
export type ProjectMembersResponse = { members: ProjectMember[] };

export type CreateProjectRequest = {
  name: string;
  slug?: string;
  /** 'github' connects a repo; 'local' opens the folder-upload path. */
  source?: "github" | "local";
  githubRepo?: string;
  defaultBranch?: string;
  upstreamUrl?: string;
};

export type AddProjectMemberRequest = {
  /** The org member to add, by user id. */
  userId: string;
  role?: ProjectRole;
};

export type UpdateProjectMemberRequest = {
  role: ProjectRole;
};
