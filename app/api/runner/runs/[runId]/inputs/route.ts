import { limitedJson } from "../../../../../lib/http/body";
import { bearerToken, deviceFromToken } from "../../../../../lib/runner/devices";
import { claimedJob } from "../../../../../lib/runner/jobs";
import { consumeChatInput } from "../../../../../lib/ai/input-queue";
import { ControlError, isUuid } from "../../../../../lib/ai/turns";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request, context: RouteContext<"/api/runner/runs/[runId]/inputs">) {
  const device = await deviceFromToken(bearerToken(request));
  if (!device) return Response.json({error:"Unknown or revoked device token."},{status:401});
  const {runId:turnId} = await context.params;
  if (!isUuid(turnId)) return Response.json({error:"Invalid turn ID."},{status:400});
  const job = await claimedJob(turnId,device.id);
  if (!job) return Response.json({error:"This device does not own a live execution lease."},{status:403});
  const body = await limitedJson(request, 8192).catch(()=>null) as { kind?: string; claimId?: string; closeIfEmpty?: boolean; id?: string; error?: string } | null;
  if (!body || !['claim','ack','uncertain'].includes(body.kind ?? '')) return Response.json({error:"Invalid input action."},{status:400});
  try {
    const input = await consumeChatInput(job,body.kind==='claim'
      ? {kind:'claim',claimId:body.claimId ?? '',closeIfEmpty:body.closeIfEmpty===true}
      : {kind:body.kind as 'ack'|'uncertain',id:body.id ?? '',error:typeof body.error==='string'?body.error:undefined});
    return Response.json({input},{headers:{'cache-control':'no-store'}});
  } catch(error) {
    if(error instanceof ControlError)return Response.json({error:error.message},{status:error.status});
    throw error;
  }
}
