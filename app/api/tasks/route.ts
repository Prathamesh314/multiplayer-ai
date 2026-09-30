import { currentUser } from "../../lib/auth/tokens";
import { unauthenticated } from "../../lib/session/auth";
import { createTask, listTasks, taskMembers, TaskError } from "../../lib/tasks/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const user = await currentUser();
  if (!user) return unauthenticated();
  const params = new URL(request.url).searchParams;
  const sessionId = params.get("sessionId"), runId = params.get("runId");
  const offset = Number(params.get("offset") ?? 0);
  if ((runId && !sessionId) || !Number.isSafeInteger(offset) || offset < 0 || offset > 100000) {
    return Response.json({ error: "Invalid task scope or page." }, { status:400 });
  }
  try {
    const scope = sessionId && runId ? {sessionId,runId} : undefined;
    const tasks = sessionId && !runId ? [] : await listTasks(user.id,scope,offset);
    const members = sessionId && params.get("members") !== "0" ? await taskMembers(sessionId,user.id) : [];
    return Response.json({ tasks:tasks.slice(0,50), hasMore:tasks.length > 50, members }, { headers:{ "cache-control":"no-store" } });
  } catch (error) {
    if (error instanceof TaskError) return Response.json({error:error.message}, {status:error.status});
    throw error;
  }
}

export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return unauthenticated();
  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({error:"Expected JSON."},{status:400}); }
  try {
    const task = await createTask(user.id,body);
    return Response.json(task,{status:201});
  } catch (error) {
    if (error instanceof TaskError) return Response.json({error:error.message},{status:error.status});
    throw error;
  }
}
