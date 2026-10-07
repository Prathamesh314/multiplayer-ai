"use client";
import { useRef, useState } from "react";
import type { ChatReview } from "../../lib/collaboration/types";
import { sharingRequest } from "../../lib/sharing/client";
import { ComposerPicker } from "../workspace/ComposerPicker";
import { ErrorNote, GhostButton, inputClass, PrimaryButton } from "../ui/Modal";
import { useResource } from "./useResource";

type Reviews = {reviews:ChatReview[];hasMore:boolean;headSha:string|null;reviewers:{id:string;name:string}[];canRequest:boolean};
export function ReviewPanel({runId,userId}:{runId:string;userId:string}) {
  const endpoint=`/api/chats/${runId}/reviews`;
  const [offset,setOffset]=useState(0);
  const {data,error,refresh}=useResource<Reviews>(`${endpoint}?offset=${offset}`);
  const [reviewer,setReviewer]=useState(''),[note,setNote]=useState(''),[responses,setResponses]=useState<Record<string,string>>({});
  const [busy,setBusy]=useState(false),[failure,setFailure]=useState<string|null>(null),[notice,setNotice]=useState('');
  const request=useRef<{id:string;key:string}|null>(null);
  async function create(event:React.FormEvent){
    event.preventDefault();if(busy||!data?.headSha)return;
    const key=JSON.stringify([reviewer,note,data.headSha]);if(request.current?.key!==key)request.current={id:crypto.randomUUID(),key};
    setBusy(true);setFailure(null);
    try{await sharingRequest(endpoint,{method:'POST',body:JSON.stringify({id:request.current.id,reviewerId:reviewer,headSha:data.headSha,note})});setNote('');request.current=null;setNotice('Review requested. It is now in your teammate’s workspace inbox.');refresh();}
    catch(cause){setFailure(cause instanceof Error?cause.message:'Could not request review.');}finally{setBusy(false);}
  }
  async function resolve(review:ChatReview,status:string){
    if(busy)return;setBusy(true);setFailure(null);
    try{await sharingRequest(endpoint,{method:'PATCH',body:JSON.stringify({id:review.id,status,headSha:review.headSha,note:responses[review.id]??''})});setNotice('Review outcome saved for this version.');refresh();}
    catch(cause){setFailure(cause instanceof Error?cause.message:'Could not save the review.');}finally{setBusy(false);}
  }
  return <section className="space-y-4" aria-label="Teammate reviews">
    <p className="text-sm leading-6 text-vs-muted">Ask a teammate to inspect the saved changes in the Changes panel. Approval applies to the requested version only; it does not publish code or run AI.</p>
    {(failure||error)&&<ErrorNote>{failure??error}</ErrorNote>}{notice&&<p role="status" className="text-sm text-vs-muted">{notice}</p>}
    {!data?<GhostButton onClick={refresh}>{error?'Retry reviews':'Loading reviews…'}</GhostButton>:<>
      {data.canRequest&&<form onSubmit={create} className="space-y-3 rounded-xl border border-vs-border p-3">
        <p className="text-sm">Saved version: <code>{data.headSha?.slice(0,8)??'No saved version yet'}</code></p>
        <ComposerPicker label="Choose reviewer" value={reviewer} onChange={setReviewer} searchable placement="auto" options={data.reviewers.map(person=>({id:person.id,label:person.name}))} />
        {!data.reviewers.length&&<p className="text-sm text-vs-muted">No other editors are available. Invite a teammate, or grant an accepted guest editing access from Share chat.</p>}
        <label className="block text-sm">What should they check?<textarea rows={2} maxLength={4000} value={note} onChange={e=>setNote(e.target.value)} className={`${inputClass} mt-1`} placeholder="Requirements, risks, or specific changes to inspect…" /></label>
        <PrimaryButton type="submit" disabled={busy||!reviewer||!data.headSha}>Request teammate review</PrimaryButton>
      </form>}
      {!data.reviews.length&&<p className="text-sm text-vs-muted">No teammate reviews yet.</p>}
      {data.reviews.map(review=><article key={review.id} className="space-y-2 rounded-xl border border-vs-border p-3">
        <p className="text-sm font-medium">{review.requesterName} → {review.reviewerName}</p>
        <p className="text-xs text-vs-muted"><code>{review.headSha.slice(0,8)}</code> · {review.status.replaceAll('_',' ')}{review.stale?' · Earlier version — does not approve current changes':''}</p>
        <p className="whitespace-pre-wrap break-words text-sm">{review.requestNote}</p>
        {review.responseNote&&<p className="whitespace-pre-wrap break-words text-sm text-vs-muted">Response: {review.responseNote}</p>}
        {review.status==='requested'&&review.reviewerId===userId&&!review.stale&&<div className="space-y-2"><label className="block text-sm">Review findings<textarea rows={2} maxLength={4000} className={`${inputClass} mt-1`} value={responses[review.id]??''} onChange={e=>setResponses({...responses,[review.id]:e.target.value})}/></label><div className="flex flex-wrap gap-2"><PrimaryButton disabled={busy} onClick={()=>void resolve(review,'approved')}>Approve {review.headSha.slice(0,8)}</PrimaryButton><GhostButton disabled={busy||!responses[review.id]?.trim()} onClick={()=>void resolve(review,'changes_requested')}>Request changes</GhostButton></div></div>}
        {review.status==='requested'&&review.requestedBy===userId&&<GhostButton disabled={busy} onClick={()=>void resolve(review,'cancelled')}>Cancel request</GhostButton>}
      </article>)}
      {(offset>0||data.hasMore)&&<div className="flex gap-2"><GhostButton disabled={!offset} onClick={()=>setOffset(Math.max(0,offset-50))}>Previous reviews</GhostButton><GhostButton disabled={!data.hasMore} onClick={()=>setOffset(offset+50)}>More reviews</GhostButton></div>}
    </>}
  </section>;
}
