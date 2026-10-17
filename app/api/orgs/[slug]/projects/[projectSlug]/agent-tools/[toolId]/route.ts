import { withApiLimit } from "../../../../../../../lib/http/api-limit";
import { deleteTool, updateTool } from "../../../../../../../lib/ai/agent-tools";
import { projectToolGate, toolFailure, toolInput } from "../../../../../../../lib/ai/agent-tools-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ slug: string; projectSlug: string; toolId: string }> };

/** Change a project tool. A new definition asks every member to approve it again. */
async function handlePATCH(request: Request, context: Context) {
  const { slug, projectSlug, toolId } = await context.params;
  const gate = await projectToolGate(slug, projectSlug, true);
  if (gate.response) return gate.response;
  try {
    await updateTool({ projectId: gate.access!.project.id }, toolId, gate.access!.user.id, await toolInput(request));
    return Response.json({ updated: true });
  } catch (error) {
    return toolFailure(error);
  }
}

async function handleDELETE(_request: Request, context: Context) {
  const { slug, projectSlug, toolId } = await context.params;
  const gate = await projectToolGate(slug, projectSlug, true);
  if (gate.response) return gate.response;
  try {
    await deleteTool({ projectId: gate.access!.project.id }, toolId);
    return Response.json({ deleted: true });
  } catch (error) {
    return toolFailure(error);
  }
}

export const PATCH = withApiLimit("/api/orgs/[slug]/projects/[projectSlug]/agent-tools/[toolId]", handlePATCH);
export const DELETE = withApiLimit("/api/orgs/[slug]/projects/[projectSlug]/agent-tools/[toolId]", handleDELETE);
