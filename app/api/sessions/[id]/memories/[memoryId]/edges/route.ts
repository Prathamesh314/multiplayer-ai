import { withApiLimit } from "../../../../../../lib/http/api-limit";
import { addMemoryEdge, memoryGraph, type EdgeInput } from "../../../../../../lib/knowledge/memory-edges";
import { memoryBody, memoryRequest } from "../../../../../../lib/knowledge/memory-http";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string; memoryId: string }> };

async function handlePOST(request: Request, context: Context) {
  const { id, memoryId } = await context.params;
  return memoryRequest(id, true, async ({ user }) => {
    await addMemoryEdge(id, user.id, memoryId, await memoryBody(request) as EdgeInput);
    return memoryGraph(id, user.id, memoryId);
  });
}

export const POST = withApiLimit("/api/sessions/[id]/memories/[memoryId]/edges", handlePOST);
