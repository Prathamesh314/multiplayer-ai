import { withApiLimit } from "../../../../lib/http/api-limit";
import { sharingBody, sharingResponse, sharingUser } from "../../../../lib/sharing/http";
import { listReviews, requestReview, resolveReview } from '../../../../lib/collaboration/reviews';
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = {params:Promise<{runId:string}>};
export const GET = withApiLimit("/api/chats/[runId]/reviews",async (request:Request,context:Context)=>sharingResponse(async()=>{
  const user=await sharingUser(),{runId}=await context.params;
  return listReviews(runId,user.id,Number(new URL(request.url).searchParams.get('offset')??0));
}));
export const POST = withApiLimit("/api/chats/[runId]/reviews",async (request:Request,context:Context)=>sharingResponse(async()=>{
  const user=await sharingUser(),{runId}=await context.params;
  return requestReview(runId,user.id,await sharingBody(request));
}));
export const PATCH = withApiLimit("/api/chats/[runId]/reviews",async (request:Request,context:Context)=>sharingResponse(async()=>{
  const user=await sharingUser(),{runId}=await context.params;
  return resolveReview(runId,user.id,await sharingBody(request));
}));
