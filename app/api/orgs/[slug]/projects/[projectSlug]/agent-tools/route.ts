import { withApiLimit } from "../../../../../../lib/http/api-limit";
import { createTool, listProjectTools, type AgentTool } from "../../../../../../lib/ai/agent-tools";
import { computersSupportTools, projectToolGate, secretsOnComputers, toolFailure, toolInput } from "../../../../../../lib/ai/agent-tools-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ slug: string; projectSlug: string }> };

export type AgentToolsResponse = { tools: AgentTool[]; canManage: boolean; secretNames: string[]; computersReady: boolean };

/** The project's MCP servers and plugins, with whether the caller approved each. */
async function handleGET(_request: Request, context: Context) {
  const { slug, projectSlug } = await context.params;
  const gate = await projectToolGate(slug, projectSlug);
  if (gate.response) return gate.response;
  const { user, project } = gate.access!;
  const [tools, secretNames, computersReady] = await Promise.all([
    listProjectTools(project.id, user.id), secretsOnComputers(user.id), computersSupportTools(user.id)]);
  return Response.json({ tools, canManage: gate.canManage!, secretNames, computersReady } satisfies AgentToolsResponse,
    { headers: { "cache-control": "no-store" } });
}

/** Add a tool to the project. Managers only; members still approve it for their own computer. */
async function handlePOST(request: Request, context: Context) {
  const { slug, projectSlug } = await context.params;
  const gate = await projectToolGate(slug, projectSlug, true);
  if (gate.response) return gate.response;
  try {
    const id = await createTool({ projectId: gate.access!.project.id }, gate.access!.user.id, await toolInput(request));
    return Response.json({ id }, { status: 201 });
  } catch (error) {
    return toolFailure(error);
  }
}

export const GET = withApiLimit("/api/orgs/[slug]/projects/[projectSlug]/agent-tools", handleGET);
export const POST = withApiLimit("/api/orgs/[slug]/projects/[projectSlug]/agent-tools", handlePOST);
