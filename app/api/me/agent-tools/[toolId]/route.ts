import { withApiLimit } from "../../../../lib/http/api-limit";
import { currentUser } from "../../../../lib/auth/tokens";
import { deleteTool, updateTool } from "../../../../lib/ai/agent-tools";
import { toolFailure, toolInput } from "../../../../lib/ai/agent-tools-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ toolId: string }> };

async function handlePATCH(request: Request, context: Context) {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in to continue." }, { status: 401 });
  const { toolId } = await context.params;
  try {
    await updateTool({ ownerId: user.id }, toolId, user.id, await toolInput(request));
    return Response.json({ updated: true });
  } catch (error) {
    return toolFailure(error);
  }
}

async function handleDELETE(_request: Request, context: Context) {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in to continue." }, { status: 401 });
  const { toolId } = await context.params;
  try {
    await deleteTool({ ownerId: user.id }, toolId);
    return Response.json({ deleted: true });
  } catch (error) {
    return toolFailure(error);
  }
}

export const PATCH = withApiLimit("/api/me/agent-tools/[toolId]", handlePATCH);
export const DELETE = withApiLimit("/api/me/agent-tools/[toolId]", handleDELETE);
