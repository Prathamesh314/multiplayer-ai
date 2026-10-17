import { withApiLimit } from "../../../../lib/http/api-limit";
import { setChatLink } from "../../../../lib/sharing/store";
import { sharingBody, sharingResponse, sharingUser } from "../../../../lib/sharing/http";
export const runtime = "nodejs";
type Context = {params:Promise<{runId:string}>};
/** General access: `{role:"viewer"|"commenter"}` lets anyone with the link open the chat; `{role:null}` restricts it to added people. */
export const PUT = withApiLimit("/api/shared-chats/[runId]/link", async (request:Request,context:Context) => sharingResponse(async () => {
  const user=await sharingUser(),{runId}=await context.params;
  const body=await sharingBody(request) as {role?:unknown}|null;
  return {link:await setChatLink(runId,user.id,body?.role??null)};
}));
