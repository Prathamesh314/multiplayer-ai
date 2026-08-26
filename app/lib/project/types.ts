import type { SessionRole } from "../session/types";

/** A project's own role scheme, distinct from the room-level SessionRole. */
export type ProjectRole = "admin" | "editor" | "viewer";

export const canManageProject = (role: ProjectRole | null | undefined): boolean =>
  role === "admin";

/**
 * How a project role maps onto what someone can do inside a room. Access is
 * settled at the project level, so a room never carries its own roster for an
 * org project — this is the single translation.
 */
export function projectRoleToSessionRole(role: ProjectRole): SessionRole {
  switch (role) {
    case "admin":
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
