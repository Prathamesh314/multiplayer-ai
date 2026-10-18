import { withApiLimit } from "../../../lib/http/api-limit";
import { acceptChatInvitation, readSharedChat } from "../../../lib/sharing/store";
import { sharingBody, sharingResponse, sharingUser } from "../../../lib/sharing/http";
import { currentUser } from "../../../lib/auth/tokens";
import { pendingEditorInvitation, SharingError } from "../../../lib/sharing/store";
import { grantInvitedEditor } from "../../../lib/collaboration/promotion";
export const runtime = "nodejs";
type Context = {params:Promise<{runId:string}>};
export const GET = withApiLimit("/api/shared-chats/[runId]", async (request:Request,context:Context) => sharingResponse(async () => {
  // "Anyone with the link" needs no account; everyone else signs in.
  const link = request.headers.get("x-chat-link"), user = await currentUser(), {runId} = await context.params;
  if (!user && !link) throw new SharingError("Sign in or create an account to open this invitation.",401);
  const params = new URL(request.url).searchParams;
  const read = () => readSharedChat(runId,user?.id??null,Number(params.get("after")??0),params.get("commentsBefore")??undefined,link);
  const chat = await read();
  // Shared as Editor and opened for the first time: become an editor of the room, under the host's authority.
  const invitation = user && chat.role === "editor" ? await pendingEditorInvitation(runId,user.id) : null;
  if (!invitation) return chat;
  const outcome = await grantInvitedEditor(runId,invitation).catch(() => ({ granted:false, reason:undefined as string | undefined }));
  if (outcome.granted) return read();
  return { ...chat, editorPending: outcome.reason ?? "Editing access needs an administrator’s approval." };
}));
export const POST = withApiLimit("/api/shared-chats/[runId]", async (request:Request,context:Context) => sharingResponse(async () => {
  const user = await sharingUser(), {runId} = await context.params;
  const body = await sharingBody(request) as {token?:unknown}|null;
  await acceptChatInvitation(runId,user.id,body?.token);
  return {ok:true};
}));
