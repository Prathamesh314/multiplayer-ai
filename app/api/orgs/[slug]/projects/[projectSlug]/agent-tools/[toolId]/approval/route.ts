import { withApiLimit } from "../../../../../../../../lib/http/api-limit";
import { approveTool, revokeTool, toolInProject } from "../../../../../../../../lib/ai/agent-tools";
import { projectToolGate, toolFailure } from "../../../../../../../../lib/ai/agent-tools-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ slug: string; projectSlug: string; toolId: string }> };

async function gated(context: Context) {
  const { slug, projectSlug, toolId } = await context.params;
  const gate = await projectToolGate(slug, projectSlug);
  if (gate.response) return { response: gate.response };
  if (!(await toolInProject(toolId, gate.access!.project.id))) return { response: Response.json({ error: "Tool not found." }, { status: 404 }) };
  return { toolId, userId: gate.access!.user.id };
}

/** Allow this tool's current definition to run on the caller's computers. */
async function handlePOST(_request: Request, context: Context) {
  const gate = await gated(context);
  if (gate.response) return gate.response;
  try {
    await approveTool(gate.toolId!, gate.userId!);
    return Response.json({ approved: true });
  } catch (error) {
    return toolFailure(error);
  }
}

async function handleDELETE(_request: Request, context: Context) {
  const gate = await gated(context);
  if (gate.response) return gate.response;
  await revokeTool(gate.toolId!, gate.userId!);
  return Response.json({ approved: false });
}

export const POST = withApiLimit("/api/orgs/[slug]/projects/[projectSlug]/agent-tools/[toolId]/approval", handlePOST);
export const DELETE = withApiLimit("/api/orgs/[slug]/projects/[projectSlug]/agent-tools/[toolId]/approval", handleDELETE);
