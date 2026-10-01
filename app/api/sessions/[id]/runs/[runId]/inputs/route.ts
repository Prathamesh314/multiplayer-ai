import { limitedJson } from "../../../../../../lib/http/body";
import { access, denied } from "../../../../../../lib/session/auth";
import { getRun } from "../../../../../../lib/ai/runs";
import { ControlError, isUuid } from "../../../../../../lib/ai/turns";
import { listChatInputs, enqueueChatInput, cancelChatInput } from "../../../../../../lib/ai/input-queue";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function handle(request: Request, context: RouteContext<"/api/sessions/[id]/runs/[runId]/inputs">) {
  const { id, runId } = await context.params;
  const result = await access(id), refusal = denied(result);
  if (refusal || !result) return refusal!;
  if (!isUuid(runId)) return Response.json({ error:"Invalid chat ID." },{status:400});
  const run = await getRun(runId);
  if (!run || run.sessionId!==id) return Response.json({error:"Chat not found."},{status:404});
  try {
    if (request.method==='GET') return Response.json({inputs:await listChatInputs(runId)},{headers:{'cache-control':'no-store'}});
    const body = await limitedJson(request, 256 * 1024).catch(()=>null);
    if (request.method==='DELETE') {
      await cancelChatInput(runId,result.user.id,(body as {id?: string} | null)?.id ?? "");
      return Response.json({ok:true});
    }
    return Response.json({input:await enqueueChatInput(runId,result.user.id,body)},{status:202});
  } catch(error) {
    if (error instanceof ControlError) return Response.json({error:error.message},{status:error.status});
    throw error;
  }
}
export const GET = handle;
export const POST = handle;
export const DELETE = handle;
