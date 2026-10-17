import { withApiLimit } from "../../../lib/http/api-limit";
import { currentUser } from "../../../lib/auth/tokens";
import { createTool, listPersonalTools, type AgentTool } from "../../../lib/ai/agent-tools";
import { computersSupportTools, secretsOnComputers, toolFailure, toolInput } from "../../../lib/ai/agent-tools-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type PersonalToolsResponse = { tools: AgentTool[]; secretNames: string[]; computersReady: boolean };

/** The caller's own MCP servers and plugins, used in all of their chats. */
async function handleGET() {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in to continue." }, { status: 401 });
  const [tools, secretNames, computersReady] = await Promise.all([listPersonalTools(user.id), secretsOnComputers(user.id), computersSupportTools(user.id)]);
  return Response.json({ tools, secretNames, computersReady } satisfies PersonalToolsResponse, { headers: { "cache-control": "no-store" } });
}

async function handlePOST(request: Request) {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in to continue." }, { status: 401 });
  try {
    const id = await createTool({ ownerId: user.id }, user.id, await toolInput(request));
    return Response.json({ id }, { status: 201 });
  } catch (error) {
    return toolFailure(error);
  }
}

export const GET = withApiLimit("/api/me/agent-tools", handleGET);
export const POST = withApiLimit("/api/me/agent-tools", handlePOST);
