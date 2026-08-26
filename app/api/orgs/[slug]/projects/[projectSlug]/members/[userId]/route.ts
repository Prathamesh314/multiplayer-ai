import { forbidden, orgDenied, projectAccess } from "../../../../../../../lib/org/auth";
import { removeProjectMember } from "../../../../../../../lib/project/store";
import { canManageProject } from "../../../../../../../lib/project/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Remove someone from the project, revoking their access to all its rooms. */
export async function DELETE(
  _request: Request,
  context: RouteContext<"/api/orgs/[slug]/projects/[projectSlug]/members/[userId]">,
) {
  const { slug, projectSlug, userId } = await context.params;
  const result = await projectAccess(slug, projectSlug);
  const refusal = orgDenied(result);
  if (refusal || !result) return refusal!;

  if (!canManageProject(result.role)) {
    return forbidden("Only a project admin can remove members.");
  }

  await removeProjectMember(result.project.id, userId);
  return Response.json({ removed: true });
}
