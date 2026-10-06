import { withApiLimit } from "../../../../lib/http/api-limit";
import { createChatInvitation, listChatInvitations, revokeChatInvitation } from "../../../../lib/sharing/store";
import { sharingBody, sharingResponse, sharingUser } from "../../../../lib/sharing/http";
export const runtime = "nodejs";
type Context = {params:Promise<{runId:string}>};
export const GET = withApiLimit("/api/shared-chats/[runId]/invitations", async (_:Request,context:Context) => sharingResponse(async () => {
  const user=await sharingUser(),{runId}=await context.params;
  return {invitations:await listChatInvitations(runId,user.id)};
}));
export const POST = withApiLimit("/api/shared-chats/[runId]/invitations", async (request:Request,context:Context) => sharingResponse(async () => {
  const user=await sharingUser(),{runId}=await context.params;
  return createChatInvitation(runId,user.id,await sharingBody(request));
},201));
export const DELETE = withApiLimit("/api/shared-chats/[runId]/invitations", async (request:Request,context:Context) => sharingResponse(async () => {
  const user=await sharingUser(),{runId}=await context.params;
  const body=await sharingBody(request) as {id?:unknown}|null;
  await revokeChatInvitation(runId,user.id,body?.id);
  return {ok:true};
}));
