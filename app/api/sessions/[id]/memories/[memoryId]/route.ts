import { transitionMemory } from "../../../../../lib/knowledge/memory-records";
import { memoryGraph } from "../../../../../lib/knowledge/memory-edges";
import { memoryBody, memoryRequest } from "../../../../../lib/knowledge/memory-http";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string; memoryId: string }> };

export async function GET(request: Request, context: Context) {
  const { id, memoryId } = await context.params;
  return memoryRequest(id, false, ({ user }) => memoryGraph(id, user.id, memoryId, Number(new URL(request.url).searchParams.get("hops") ?? 3)));
}

export async function PATCH(request: Request, context: Context) {
  const { id, memoryId } = await context.params;
  return memoryRequest(id, true, async ({ user }) => {
    const body = await memoryBody(request);
    return { memory: await transitionMemory(id, user.id, memoryId, body as Parameters<typeof transitionMemory>[3]) };
  });
}
