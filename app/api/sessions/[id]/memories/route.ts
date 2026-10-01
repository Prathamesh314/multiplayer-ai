import { withApiLimit } from "../../../../lib/http/api-limit";
import { createMemory, listMemories, MemoryError, type CreateMemory, type MemoryStatus } from "../../../../lib/knowledge/memory-records";
import { memoryBody, memoryRequest } from "../../../../lib/knowledge/memory-http";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

async function handleGET(request: Request, context: Context) {
  const { id } = await context.params;
  return memoryRequest(id, false, async ({ user }) => {
    const params = new URL(request.url).searchParams;
    const limit = params.has("limit") ? Number(params.get("limit")) : 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new MemoryError("Limit must be between 1 and 100.");
    const memories = await listMemories(id, user.id, { status: params.get("status") as MemoryStatus | undefined,
      before: params.get("before") ?? undefined, limit });
    return { memories, nextCursor: memories.length === limit ? memories.at(-1)!.id : null };
  });
}

async function handlePOST(request: Request, context: Context) {
  const { id } = await context.params;
  return memoryRequest(id, true, async ({ user }) => {
    const body = await memoryBody(request);
    if (body.evidenceQuote !== undefined && (typeof body.evidenceQuote !== "string" || body.evidenceQuote.length > 4000)) throw new MemoryError("Invalid evidence quote.");
    return { memory: await createMemory(id, user.id, body as CreateMemory) };
  });
}

export const GET = withApiLimit("/api/sessions/[id]/memories", handleGET);
export const POST = withApiLimit("/api/sessions/[id]/memories", handlePOST);
