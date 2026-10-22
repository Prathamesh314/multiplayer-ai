/** Org, project and invitation shapes as the client is allowed to see them. */

export type OrgRole = "owner" | "admin" | "member";

/** The database's admin capabilities: owner and admin can manage; member cannot. */
export const canManageOrg = (role: OrgRole | null | undefined): boolean =>
  role === "owner" || role === "admin";

/** One org in the sidebar rail. */
export type Org = {
  id: string;
  slug: string;
  name: string;
  image: string;
  /** The requesting account's role, for gating the manage UI. */
  myRole: OrgRole;
  createdAt: number;
};

/** A person on an org's roster. */
export type OrgMember = {
  userId: string;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  role: OrgRole;
  status: "active" | "suspended";
  joinedAt: number;
};

export type OrgMembersResponse = { members: OrgMember[] };

/** Members with the app open right now. */
export type OrgOnlineResponse = { people: { userId: string; handle: string; displayName: string; avatarUrl: string | null; isSelf: boolean }[] };

/** Admin changes a member's role and/or active status. Either field may be sent. */
export type UpdateOrgMemberRequest = {
  role?: OrgRole;
  status?: "active" | "suspended";
};

export type OrgListResponse = { orgs: Org[] };

export type CreateOrgRequest = { name: string; slug?: string };

/** An invitation the recipient can act on. */
export type PendingInvitation = {
  id: string;
  orgId: string;
  orgName: string;
  orgSlug: string;
  role: "admin" | "member";
  invitedByName: string;
  createdAt: number;
  expiresAt: number;
};

export type PendingInvitationsResponse = { invitations: PendingInvitation[] };

/** Admin adds someone by pasting their connect code. */
export type InviteByCodeRequest = { connectCode: string; role?: "admin" | "member" };

/** Admin emails an invite; the response carries the one-time link token. */
export type InviteByEmailRequest = { email: string; role?: "admin" | "member" };
export type InviteByEmailResponse = { token: string; expiresAt: number };
