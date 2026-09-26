import { currentUser } from "../../../lib/auth/tokens";
import { unauthenticated } from "../../../lib/session/auth";
import { TaskError, updateTask } from "../../../lib/tasks/store";

export const runtime = "nodejs";
export async function PATCH(request: Request, context: {params:Promise<{id:string}>}) {
  const user = await currentUser();
  if (!user) return unauthenticated();
  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({error:"Expected JSON."},{status:400}); }
  try {
    await updateTask(user.id,(await context.params).id,body && typeof body === "object" ? (body as Record<string,unknown>).status : null);
    return Response.json({updated:true});
  } catch (error) {
    if (error instanceof TaskError) return Response.json({error:error.message},{status:error.status});
    throw error;
  }
}
