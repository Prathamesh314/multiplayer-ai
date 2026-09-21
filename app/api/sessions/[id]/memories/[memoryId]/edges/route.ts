import { addMemoryEdge, memoryGraph, type EdgeInput } from "../../../../../../lib/knowledge/memory-edges";
import { memoryBody, memoryRequest } from "../../../../../../lib/knowledge/memory-http";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string; memoryId: string }> };

export async function POST(request: Request, context: Context) {
  const { id, memoryId } = await context.params;
  return memoryRequest(id, true, async ({ user }) => {
    await addMemoryEdge(id, user.id, memoryId, await memoryBody(request) as EdgeInput);
    return memoryGraph(id, user.id, memoryId);
  });
}
