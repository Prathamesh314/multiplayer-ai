import { withApiLimit } from "../../../../lib/http/api-limit";
import { addSharedComment } from "../../../../lib/sharing/store";
import { sharingBody, sharingResponse, sharingUser } from "../../../../lib/sharing/http";
export const runtime = "nodejs";
export const POST = withApiLimit("/api/shared-chats/[runId]/comments", async (request:Request,context:{params:Promise<{runId:string}>}) => sharingResponse(async () => {
  const user=await sharingUser(),{runId}=await context.params;
  return addSharedComment(runId,user.id,await sharingBody(request));
},201));
