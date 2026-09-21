import { currentUser } from "../../../../lib/auth/tokens";
import { requestSessionDeletion,restoreSession,RetentionError } from "../../../../lib/session/retention";
export const runtime="nodejs";
type Context={params:Promise<{id:string}>};
export async function POST(request:Request,context:Context) {
  const user=await currentUser();
  if(!user) return Response.json({error:"Sign in first."},{status:401});
  try {
    const {id}=await context.params;
    const body=await request.json();
    if(body?.action==='restore') {await restoreSession(id,user.id);return Response.json({restored:true});}
    if(body?.action!=='delete'||typeof body.confirmName!=='string') throw new RetentionError('Provide action and exact room name.');
    return Response.json({deletion:await requestSessionDeletion(id,user.id,body.confirmName)},{status:202});
  } catch(cause) {
    if(cause instanceof RetentionError) return Response.json({error:cause.message},{status:cause.status});
    if(cause instanceof SyntaxError) return Response.json({error:'Expected JSON.'},{status:400});
    console.error('Retention request failed',cause);
    return Response.json({error:'Could not complete retention action. Your saved repository is preserved.'},{status:503});
  }
}
