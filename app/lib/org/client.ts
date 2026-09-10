import { NotSignedIn } from "../session/client";
import type {
  CreateOrgRequest,
  Org,
  OrgListResponse,
  OrgMember,
  OrgMembersResponse,
  OrgRole,
  PendingInvitation,
  PendingInvitationsResponse,
} from "./types";

async function readError(response: Response, fallback: string): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? fallback;
}

export async function listMyOrgs(): Promise<Org[]> {
  const response = await fetch("/api/orgs", { cache: "no-store" });
  if (response.status === 401) throw new NotSignedIn();
  if (!response.ok) throw new Error(await readError(response, "Could not load your organisations."));
  return ((await response.json()) as OrgListResponse).orgs;
}

export async function createOrg(input: CreateOrgRequest): Promise<Org> {
  const response = await fetch("/api/orgs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (response.status === 401) throw new NotSignedIn();
  if (!response.ok) throw new Error(await readError(response, "Could not create the organisation."));
  return (await response.json()) as Org;
}

export type OrgUsage = {
  concurrency: { used: number; limit: number };
  monthly: { used: number; limit: number | null };
};

/** The org's pooled AI-run usage against its limits. */
export async function fetchOrgUsage(slug: string): Promise<OrgUsage | null> {
  const response = await fetch(`/api/orgs/${encodeURIComponent(slug)}/usage`, { cache: "no-store" });
  if (!response.ok) return null;
  return (await response.json()) as OrgUsage;
}

export async function fetchOrgMembers(slug: string): Promise<OrgMember[]> {
  const response = await fetch(`/api/orgs/${encodeURIComponent(slug)}/members`, { cache: "no-store" });
  if (!response.ok) return [];
  return ((await response.json()) as OrgMembersResponse).members;
}

/** Change a member's org role and/or active status. Org admins only. */
export async function updateOrgMember(
  slug: string,
  userId: string,
  changes: { role?: OrgRole; status?: "active" | "suspended" },
): Promise<void> {
  const response = await fetch(
    `/api/orgs/${encodeURIComponent(slug)}/members/${encodeURIComponent(userId)}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(changes),
    },
  );
  if (!response.ok) throw new Error(await readError(response, "Could not update that member."));
}

/** Remove someone from the org entirely. Org admins only. */
export async function removeOrgMember(slug: string, userId: string): Promise<void> {
  const response = await fetch(
    `/api/orgs/${encodeURIComponent(slug)}/members/${encodeURIComponent(userId)}`,
    { method: "DELETE" },
  );
  if (!response.ok) throw new Error(await readError(response, "Could not remove that member."));
}

/** Invite by pasting a connect code. Returns nothing useful; success is a 201. */
export async function inviteByConnectCode(
  slug: string,
  connectCode: string,
  role: "admin" | "member" = "member",
): Promise<{ displayName: string; handle: string }> {
  const response = await fetch(`/api/orgs/${encodeURIComponent(slug)}/invitations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ via: "connect_code", connectCode, role }),
  });
  if (!response.ok) throw new Error(await readError(response, "Could not send that invitation."));
  return ((await response.json()) as { invited: { displayName: string; handle: string } }).invited;
}

/** Invite by email; the one-time link is returned to copy and share. */
export async function inviteByEmail(
  slug: string,
  email: string,
  role: "admin" | "member" = "member",
): Promise<{ link: string; expiresAt: number }> {
  const response = await fetch(`/api/orgs/${encodeURIComponent(slug)}/invitations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ via: "email", email, role }),
  });
  if (!response.ok) throw new Error(await readError(response, "Could not create the invite link."));
  return (await response.json()) as { link: string; expiresAt: number };
}

export async function listPendingInvitations(): Promise<PendingInvitation[]> {
  const response = await fetch("/api/invitations", { cache: "no-store" });
  if (!response.ok) return [];
  return ((await response.json()) as PendingInvitationsResponse).invitations;
}

export async function acceptInvitation(id: string): Promise<string> {
  const response = await fetch(`/api/invitations/${encodeURIComponent(id)}/accept`, {
    method: "POST",
  });
  if (!response.ok) throw new Error(await readError(response, "Could not accept that invitation."));
  return ((await response.json()) as { orgSlug: string }).orgSlug;
}

export async function acceptInvitationToken(token: string): Promise<string> {
  const response = await fetch("/api/invitations/accept", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (!response.ok) throw new Error(await readError(response, "That invitation link is not valid."));
  return ((await response.json()) as { orgSlug: string }).orgSlug;
}

export async function updateOrgSettings(
  slug: string,
  data: { name: string; image?: string | null }
): Promise<Org> {
  const res = await fetch(`/api/orgs/${slug}/settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error("Failed to update organization settings");
  return res.json();
}
