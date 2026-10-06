import { withApiLimit } from "../../../lib/http/api-limit";
import { acceptChatInvitation, readSharedChat } from "../../../lib/sharing/store";
import { sharingBody, sharingResponse, sharingUser } from "../../../lib/sharing/http";
export const runtime = "nodejs";
type Context = {params:Promise<{runId:string}>};
export const GET = withApiLimit("/api/shared-chats/[runId]", async (request:Request,context:Context) => sharingResponse(async () => {
  const user = await sharingUser(), {runId} = await context.params;
  const params = new URL(request.url).searchParams;
  return readSharedChat(runId,user.id,Number(params.get("after")??0),params.get("commentsBefore")??undefined);
}));
export const POST = withApiLimit("/api/shared-chats/[runId]", async (request:Request,context:Context) => sharingResponse(async () => {
  const user = await sharingUser(), {runId} = await context.params;
  const body = await sharingBody(request) as {token?:unknown}|null;
  await acceptChatInvitation(runId,user.id,body?.token);
  return {ok:true};
}));
