import { withApiLimit } from "../../../../lib/http/api-limit";
import { sharingBody, sharingResponse, sharingUser } from "../../../../lib/sharing/http";
import { readFeedback, markFeedbackRead } from '../../../../lib/collaboration/feedback';
import { SharingError } from '../../../../lib/sharing/store';
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = {params:Promise<{runId:string}>};
export const GET = withApiLimit("/api/chats/[runId]/feedback",async (request:Request,context:Context)=>sharingResponse(async()=>{
  const user=await sharingUser(),{runId}=await context.params;
  const raw=new URL(request.url).searchParams.get('before'); const before=raw===null?undefined:Number(raw); if(before!==undefined&&(!Number.isSafeInteger(before)||before<1))throw new SharingError('Invalid comment position.',400); return readFeedback(runId,user.id,before);
}));
export const PUT = withApiLimit("/api/chats/[runId]/feedback",async (request:Request,context:Context)=>sharingResponse(async()=>{
  const user=await sharingUser(),{runId}=await context.params;
  const body=await sharingBody(request) as {seq?:unknown}|null; return markFeedbackRead(runId,user.id,body?.seq);
}));
