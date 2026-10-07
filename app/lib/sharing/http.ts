import { currentUser } from "../auth/tokens";
import { limitedJson } from "../http/body";
import { SharingError } from "./store";

export async function sharingUser() {
  const user = await currentUser();
  if (!user) throw new SharingError("Sign in or create an account to open this invitation.",401);
  return user;
}
export async function sharingBody(request: Request) {
  return limitedJson(request,40_000).catch(() => { throw new SharingError("That request couldn’t be read. Please try again.",400); });
}
export async function sharingResponse(work: () => Promise<unknown>, status = 200) {
  try { return Response.json(await work(),{status,headers:{"cache-control":"no-store"}}); }
  catch(error) {
    if (error instanceof SharingError) return Response.json({error:error.message},{status:error.status});
    throw error;
  }
}
