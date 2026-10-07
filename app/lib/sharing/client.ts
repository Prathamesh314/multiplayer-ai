export class SharingRequestError extends Error {
  constructor(message:string, public status:number) {super(message);}
}
export async function sharingRequest<T>(url:string, init:RequestInit = {}):Promise<T> {
  const response = await fetch(url,{...init,cache:"no-store",signal:init.signal??AbortSignal.timeout(15_000),headers:{"content-type":"application/json",...init.headers}}).catch(()=>{throw new Error("Couldn’t reach the workspace. Check your connection and try again. Your unsent text is still here.");});
  const data = await response.json().catch(()=>null);
  if (!response.ok) throw new SharingRequestError(data?.error??"Couldn’t load this chat. Please try again.",response.status);
  if (!data) throw new Error("The server returned an incomplete response. Please try again.");
  return data as T;
}
export const sharedChatPath = (runId:string) => `/shared/${encodeURIComponent(runId)}`;
export const sharedChatApi = (runId:string) => `/api/shared-chats/${encodeURIComponent(runId)}`;
