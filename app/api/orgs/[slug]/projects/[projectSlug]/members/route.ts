import { forbidden, orgDenied, projectAccess } from "../../../../../../lib/org/auth";
import { addProjectMember, listProjectMembers } from "../../../../../../lib/project/store";
import { ensureMemberRoom } from "../../../../../../lib/session/memberRoom";
import { canManageProject } from "../../../../../../lib/project/types";
import type { AddProjectMemberRequest, ProjectMembersResponse } from "../../../../../../lib/project/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The project roster — who can open every room in it. */
export async function GET(
  _request: Request,
  context: RouteContext<"/api/orgs/[slug]/projects/[projectSlug]/members">,
) {
  const { slug, projectSlug } = await context.params;
  const result = await projectAccess(slug, projectSlug);
  const refusal = orgDenied(result);
  if (refusal || !result) return refusal!;

  const members = await listProjectMembers(result.project.id);
  return Response.json({ members } satisfies ProjectMembersResponse, {
    headers: { "cache-control": "no-store" },
  });
}

/** Add an org member to the project. Project admins only. */
export async function POST(
  request: Request,
  context: RouteContext<"/api/orgs/[slug]/projects/[projectSlug]/members">,
) {
  const { slug, projectSlug } = await context.params;
  const result = await projectAccess(slug, projectSlug);
  const refusal = orgDenied(result);
  if (refusal || !result) return refusal!;

  if (!canManageProject(result.role)) {
    return forbidden("Only a project admin can add members.");
  }

  let body: AddProjectMemberRequest;
  try {
    body = (await request.json()) as AddProjectMemberRequest;
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const userId = String(body.userId ?? "");
  if (!userId) return Response.json({ error: "Name the member to add." }, { status: 400 });
  const role = body.role === "manager" ? "manager" : body.role === "viewer" ? "viewer" : "editor";

  const outcome = await addProjectMember(result.project.id, result.org.id, userId, role, result.user.id);
  if (!outcome.ok) return Response.json({ error: outcome.error }, { status: 409 });

  // Their one room in this project, ready before they first look. Best-effort:
  // if seeding fails here, listing the rooms provisions it instead.
  await ensureMemberRoom(result.project, userId, role).catch(() => null);

  return Response.json({ added: true }, { status: 201 });
}
