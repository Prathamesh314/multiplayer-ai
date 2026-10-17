import { withApiLimit } from "../../../../lib/http/api-limit";
import { publicOrigin } from "../../../../lib/http/public-origin";
import { queryOne } from "../../../../lib/db/client";
import { createChatInvitation, getChatLink, listChatInvitations, recentShares, revokeChatInvitation } from "../../../../lib/sharing/store";
import { sharingBody, sharingResponse, sharingUser } from "../../../../lib/sharing/http";
import { sendShareEmail, shareEmailConfigured } from "../../../../lib/sharing/notify";
import { sharedChatPath } from "../../../../lib/sharing/client";
export const runtime = "nodejs";
type Context = {params:Promise<{runId:string}>};
/** Notification email per person per hour; sharing itself is not limited by this. */
const NOTIFY_PER_HOUR = 30;

/** Who has access, and whether anyone with the link can open the chat. */
export const GET = withApiLimit("/api/shared-chats/[runId]/invitations", async (_:Request,context:Context) => sharingResponse(async () => {
  const user=await sharingUser(),{runId}=await context.params;
  return {invitations:await listChatInvitations(runId,user.id),link:await getChatLink(runId,user.id),canNotify:shareEmailConfigured()};
}));
/** Add a person by email (or change their role). They open the chat's own link while signed in with that email. */
export const POST = withApiLimit("/api/shared-chats/[runId]/invitations", async (request:Request,context:Context) => sharingResponse(async () => {
  const user=await sharingUser(),{runId}=await context.params;
  const body=await sharingBody(request) as {email?:unknown;role?:unknown;notify?:unknown;message?:unknown}|null;
  const {invitation}=await createChatInvitation(runId,user.id,body,"email");
  let notified=false;
  if (body?.notify===true) {
    const chat=await queryOne<{title:string}>("SELECT COALESCE(title,'AI chat') AS title FROM agent_runs WHERE id=$1",[runId]);
    let origin:string|null=null;
    try{origin=publicOrigin(request);}catch{/* no public address configured: the host copies the link instead */}
    if (chat && origin && await recentShares(user.id)<=NOTIFY_PER_HOUR) notified=await sendShareEmail({to:invitation.email,hostName:user.displayName,title:chat.title,
      url:`${origin}${sharedChatPath(runId)}`,role:invitation.role,message:typeof body?.message==="string"?body.message:undefined});
  }
  return {invitation,notified};
},201));
export const DELETE = withApiLimit("/api/shared-chats/[runId]/invitations", async (request:Request,context:Context) => sharingResponse(async () => {
  const user=await sharingUser(),{runId}=await context.params;
  const body=await sharingBody(request) as {id?:unknown}|null;
  await revokeChatInvitation(runId,user.id,body?.id);
  return {ok:true};
}));
