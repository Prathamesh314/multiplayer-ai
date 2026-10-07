"use client";
import { useEffect, useRef, useState } from "react";
import type { Feedback, FeedbackComment } from "../../lib/collaboration/types";
import { sharingRequest } from "../../lib/sharing/client";
import { ErrorNote, GhostButton, inputClass, PrimaryButton } from "../ui/Modal";
import { useResource } from "./useResource";

export function FeedbackPanel({runId,onRead}:{runId:string;onRead?:()=>void}) {
  const endpoint=`/api/chats/${encodeURIComponent(runId)}/feedback`;
  const {data,error,refresh}=useResource<Feedback>(endpoint);
  const [older,setOlder]=useState<FeedbackComment[]>([]),[hasOlder,setHasOlder]=useState<boolean|null>(null);
  const [coveredThrough,setCoveredThrough]=useState<number|null>(null);
  const [before,setBefore]=useState<number|null>(null);
  const [pagingThrough,setPagingThrough]=useState<number|null>(null);
  const [draft,setDraft]=useState(''),[busy,setBusy]=useState(false),[failure,setFailure]=useState<string|null>(null);
  const pending=useRef<{id:string;body:string}|null>(null);
  const last=data?.comments.at(-1)?.seq;
  // A burst of more than one page between polls can leave unseen comments
  // between loaded history and the newest page. Never advance past that gap.
  const gap=!!(data?.hasMore&&coveredThrough!==null&&data.comments[0]?.seq>coveredThrough);
  const needsEarlier=!!data?.hasMore&&(hasOlder!==false||gap);
  useEffect(()=>{
    if(!last||needsEarlier)return;
    const controller=new AbortController();
    const mark=()=>{if(!document.hidden)void sharingRequest(endpoint,{method:'PUT',body:JSON.stringify({seq:last}),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15_000)])}).then(()=>onRead?.()).catch(()=>{});};
    mark();document.addEventListener('visibilitychange',mark);
    return()=>{controller.abort();document.removeEventListener('visibilitychange',mark);};
  },[endpoint,last,needsEarlier,onRead]);
  async function send(event:React.FormEvent) {
    event.preventDefault();if(busy||!draft.trim())return;
    const body=draft.trim();if(pending.current?.body!==body)pending.current={id:crypto.randomUUID(),body};
    setBusy(true);setFailure(null);
    try{await sharingRequest(`/api/shared-chats/${runId}/comments`,{method:'POST',body:JSON.stringify(pending.current)});setDraft('');pending.current=null;refresh();}
    catch(cause){setFailure(cause instanceof Error?cause.message:'Could not post. Your draft is retained.');}finally{setBusy(false);}
  }
  async function loadOlder(){
    if(busy)return;setBusy(true);
    const through=gap||before===null?last??null:pagingThrough;
    try{
      const page=await sharingRequest<Feedback>(`${endpoint}?before=${gap?data?.comments[0]?.seq:before??data?.comments[0]?.seq}`);
      setOlder(previous=>Array.from(new Map([...page.comments,...previous,...(data?.comments??[])].map(comment=>[comment.id,comment])).values()).sort((a,b)=>a.seq-b.seq));
      setHasOlder(page.hasMore);setBefore(page.hasMore?page.comments[0]?.seq??null:null);setPagingThrough(through);
      if(!page.hasMore)setCoveredThrough(through);else if(gap)setCoveredThrough(null);
    }
    catch(cause){setFailure(cause instanceof Error?cause.message:'Could not load earlier feedback.');}finally{setBusy(false);}
  }
  const comments=Array.from(new Map([...older,...(data?.comments??[])].map(c=>[c.id,c])).values()).sort((a,b)=>a.seq-b.seq);
  return <section className="space-y-3" aria-label="Conversation feedback">
    <p className="text-sm leading-6 text-vs-muted">Discuss this conversation with teammates and invited guests. Replies here are visible to chat guests and do not instruct AI.</p>
    {(error||failure)&&<ErrorNote>{failure??error}</ErrorNote>}
    {!data?<GhostButton onClick={refresh}>{error?'Retry feedback':'Loading feedback…'}</GhostButton>:<>
      {needsEarlier&&<GhostButton disabled={busy} onClick={()=>void loadOlder()}>Load earlier feedback</GhostButton>}
      {comments.map(comment=><article key={comment.id} className="rounded-xl border border-vs-border bg-vs-editor p-3"><p className="text-sm font-medium">{comment.authorName}<span className="ml-2 text-xs font-normal text-vs-muted">{new Date(comment.createdAt).toLocaleString()}</span></p><p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6">{comment.body}</p></article>)}
      {!comments.length&&<p className="text-sm text-vs-muted">No feedback yet. Share this chat to invite someone to contribute.</p>}
      {data.canComment?<form onSubmit={send} className="space-y-2"><label htmlFor="conversation-feedback" className="text-sm font-medium">Reply to the conversation</label><textarea id="conversation-feedback" className={inputClass} rows={3} maxLength={8000} value={draft} onChange={e=>setDraft(e.target.value)} placeholder="Ask a question or respond to feedback…"/><PrimaryButton type="submit" disabled={busy||!draft.trim()}>{busy?'Posting…':'Post reply'}</PrimaryButton></form>:<p className="text-sm text-vs-muted">You have read-only access.</p>}
    </>}
  </section>;
}
