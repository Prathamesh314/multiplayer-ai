import { currentUser } from "../auth/tokens";
import type { CurrentUser } from "../auth/types";
import { getProjectForUser } from "../project/store";
import type { Project, ProjectRole } from "../project/types";
import { getOrgForUser } from "./store";
import type { Org, OrgRole } from "./types";

/**
 * Route guards for the org and project layers, mirroring session/auth.ts. Same
 * three-way result: null means "not signed in", false means "signed in but no
 * access" — different responses because one is fixable by logging in.
 */

export function unauthenticated(): Response {
  return Response.json(
    { error: "Sign in to continue." },
    { status: 401, headers: { "cache-control": "no-store" } },
  );
}

/** Unknown and unauthorised look identical, so a slug can't be probed. */
export function notFound(): Response {
  return Response.json(
    { error: "Not found." },
    { status: 404, headers: { "cache-control": "no-store" } },
  );
}

export function forbidden(message: string): Response {
  return Response.json({ error: message }, { status: 403, headers: { "cache-control": "no-store" } });
}

export type OrgAccess = { user: CurrentUser; org: Org; role: OrgRole };

export async function orgAccess(slug: string): Promise<OrgAccess | null | false> {
  const user = await currentUser();
  if (!user) return null;
  const org = await getOrgForUser(slug, user.id);
  if (!org) return false;
  return { user, org, role: org.myRole };
}

export type ProjectAccess = {
  user: CurrentUser;
  org: Org;
  project: Project;
  role: ProjectRole;
};

export async function projectAccess(
  orgSlug: string,
  projectSlug: string,
): Promise<ProjectAccess | null | false> {
  const gate = await orgAccess(orgSlug);
  if (!gate || gate === null) return gate;
  const project = await getProjectForUser(gate.org.id, projectSlug, gate.user.id);
  if (!project) return false;
  return { user: gate.user, org: gate.org, project, role: project.myRole };
}

/** Turns the three-way result into the right response, or null to proceed. */
export function orgDenied(result: OrgAccess | ProjectAccess | null | false): Response | null {
  if (result === null) return unauthenticated();
  if (result === false) return notFound();
  return null;
}
