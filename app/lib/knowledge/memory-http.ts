import { access, canWrite, denied, forbidden, type Access } from "../session/auth";
import { MemoryError } from "./memory-records";

export async function memoryRequest(roomId: string, write: boolean, task: (access: Access) => Promise<unknown>): Promise<Response> {
  try {
    const result = await access(roomId);
    const refusal = denied(result);
    if (refusal || !result) return refusal!;
    if (write && !canWrite(result.role)) return forbidden("Editing memories requires room edit access.");
    return Response.json(await task(result), { headers: { "cache-control": "no-store" } });
  } catch (cause) {
    if (cause instanceof MemoryError) return Response.json({ error: cause.message }, { status: cause.status });
    console.error("Memory request failed", cause);
    return Response.json({ error: "Memory request could not be completed. Retry shortly." }, { status: 500 });
  }
}

export async function memoryBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.length > 30000) throw new MemoryError("Memory request is too large.", 413);
  try {
    const body = JSON.parse(text);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body;
  } catch { throw new MemoryError("Expected a JSON object."); }
}
