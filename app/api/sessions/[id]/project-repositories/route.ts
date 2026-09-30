import { access, denied } from "../../../../lib/session/auth";
import { projectRoleOf } from "../../../../lib/project/store";
import { listProjectRepositories } from "../../../../lib/project/repositories";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const result = await access(id);
  const refusal = denied(result);
  if (refusal || !result) return refusal!;
  const projectId = result.session.projectId;
  // Room invitations alone do not grant access to the project's other codebases.
  if (!projectId || !await projectRoleOf(projectId, result.user.id)) return Response.json({ repositories: [] });
  return Response.json({ repositories: await listProjectRepositories(projectId) }, { headers: { "cache-control": "no-store" } });
}
