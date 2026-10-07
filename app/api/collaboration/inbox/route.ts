import { withApiLimit } from "../../../lib/http/api-limit";
import { sharingResponse, sharingUser } from "../../../lib/sharing/http";
import { SharingError } from "../../../lib/sharing/store";
import { collaborationInbox } from "../../../lib/collaboration/feedback";
import { isUuid } from "../../../lib/ai/turns";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = withApiLimit("/api/collaboration/inbox",async(request:Request)=>sharingResponse(async()=>{
  const user=await sharingUser(),params=new URL(request.url).searchParams;
  const offset=Number(params.get('offset')??0),runId=params.get('runId')??undefined;
  if(!Number.isSafeInteger(offset)||offset<0||offset>10000||(runId&&!isUuid(runId)))throw new SharingError('Invalid inbox page.',400);
  return collaborationInbox(user.id,offset,runId);
}));
