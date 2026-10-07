import { withApiLimit } from "../../../../lib/http/api-limit";
import { sharingBody, sharingResponse, sharingUser } from "../../../../lib/sharing/http";
import { previewGuestAccess, grantGuestAccess, requestGuestAccess, declineGuestAccess } from '../../../../lib/collaboration/promotion';
import { publishRoleChanged } from '../../../../lib/events';
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = {params:Promise<{runId:string}>};
export const GET = withApiLimit("/api/chats/[runId]/access",async (request:Request,context:Context)=>sharingResponse(async()=>{
  const user=await sharingUser(),{runId}=await context.params;
  return previewGuestAccess(runId,user.id,new URL(request.url).searchParams.get('invitationId')??'');
}));
export const POST = withApiLimit("/api/chats/[runId]/access",async (request:Request,context:Context)=>sharingResponse(async()=>{
  const user=await sharingUser(),{runId}=await context.params;
  const body=await sharingBody(request) as {action?:unknown;invitationId?:unknown}|null;
  if(body?.action==='request')return requestGuestAccess(runId,user.id,body);
  if(body?.action==='decline')return declineGuestAccess(runId,user.id,body.invitationId);
  const result=await grantGuestAccess(runId,user.id,body); await publishRoleChanged([result.sessionId],result.userId!).catch(()=>{}); return result;
}));
