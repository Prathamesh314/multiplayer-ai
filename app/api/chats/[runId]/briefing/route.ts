import { withApiLimit } from "../../../../lib/http/api-limit";
import { sharingBody, sharingResponse, sharingUser } from "../../../../lib/sharing/http";
import { readBriefing, saveBriefing } from '../../../../lib/collaboration/briefing';
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = {params:Promise<{runId:string}>};
export const GET = withApiLimit("/api/chats/[runId]/briefing",async (request:Request,context:Context)=>sharingResponse(async()=>{
  const user=await sharingUser(),{runId}=await context.params;
  return readBriefing(runId,user.id,new URL(request.url).searchParams.get('draft')==='1');
}));
export const PUT = withApiLimit("/api/chats/[runId]/briefing",async (request:Request,context:Context)=>sharingResponse(async()=>{
  const user=await sharingUser(),{runId}=await context.params;
  return saveBriefing(runId,user.id,await sharingBody(request));
}));
