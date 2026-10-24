"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import type { InboxItem, AccessRequest } from "../../lib/collaboration/types";
import { Modal, ErrorNote, GhostButton } from "../ui/Modal";
import { FeedbackPanel } from "./FeedbackPanel";
import { ReviewPanel } from "./ReviewPanel";
import { useResource } from "./useResource";
import { GuestAccess } from "./GuestAccess";

export function CollaborationControls({runId,userId}:{runId:string;userId:string}) {
  const {data,refresh}=useResource<{items:InboxItem[]}>(`/api/collaboration/inbox?runId=${runId}`);
  const [tab,setTab]=useState<'feedback'|'reviews'|null>(()=>typeof window!=='undefined'&&['feedback','reviews'].includes(new URLSearchParams(window.location.search).get('collaboration')??'')?new URLSearchParams(window.location.search).get('collaboration') as 'feedback'|'reviews':null);
  const counts=data?.items[0];
  return <>
    <button type="button" onClick={()=>setTab('feedback')} className="rounded-lg px-2 py-1.5 text-xs text-vs-muted hover:bg-vs-hover">Feedback{counts?.unread?` · ${counts.unread} unread`:''}</button>
    <button type="button" onClick={()=>setTab('reviews')} className="rounded-lg px-2 py-1.5 text-xs text-vs-muted hover:bg-vs-hover">Teammate review{counts?.reviews?` · ${counts.reviews}`:''}</button>
    {tab&&<Modal title={tab==='feedback'?'Conversation feedback':'Teammate review'} onClose={()=>setTab(null)} width="max-w-2xl">
      <div className="flex gap-2" role="group" aria-label="Collaboration view"><GhostButton onClick={()=>setTab('feedback')}>Feedback</GhostButton><GhostButton onClick={()=>setTab('reviews')}>Reviews</GhostButton></div>
      {tab==='feedback'?<FeedbackPanel key={runId} runId={runId} onRead={refresh}/>:<ReviewPanel key={runId} runId={runId} userId={userId}/>}
    </Modal>}
  </>;
}

/**
 * Requests for your attention in the overview's action queue: access requests
 * to approve, then chats with unread feedback or review requests, one line
 * each. `label` heads the group in the queue's All view, where an empty group
 * shows nothing; `onCount` reports how many there are once both have loaded.
 */
export function CollaborationInbox({label,onCount}:{label?:string;onCount?:(count:number)=>void}={}) {
  const [offset,setOffset]=useState(0);
  const [accessOffset,setAccessOffset]=useState(0);
  const access=useResource<{items:AccessRequest[];hasMore:boolean}>(`/api/collaboration/access-requests?offset=${accessOffset}`);
  const {data,error,refresh}=useResource<{items:InboxItem[];hasMore:boolean}>(`/api/collaboration/inbox?offset=${offset}`);
  const loaded=!!data&&!!access.data;
  const count=(data?.items.length??0)+(access.data?.items.length??0);
  useEffect(()=>{if(loaded)onCount?.(count);},[loaded,count,onCount]);
  if(label&&(!loaded||count===0)&&!error&&!access.error)return null;
  return <section aria-label="Collaboration inbox" className="text-xs">
    {label&&<h3 className="border-y border-vs-border/70 bg-vs-editor/50 px-4 py-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-vs-muted">{label}</h3>}
    {access.error&&<div className="space-y-2 px-4 py-3"><ErrorNote>{access.error}</ErrorNote><GhostButton onClick={access.refresh}>Retry access requests</GhostButton></div>}
    {error&&<div className="space-y-2 px-4 py-3"><ErrorNote>{error}</ErrorNote><GhostButton onClick={refresh}>Retry inbox</GhostButton></div>}
    {!loaded&&!error&&!access.error&&<p className="px-4 py-3 text-vs-muted">Loading conversations needing your attention…</p>}
    {loaded&&count===0&&<p className="px-4 py-4 text-[13px] text-vs-muted">You’re caught up. Guest replies, teammate reviews, and requests for access appear here.</p>}
    <ul className="divide-y divide-vs-border/70">
      {access.data?.items.map(item=><li key={item.invitationId} className="space-y-2 px-4 py-3">
        <p className="text-[13px]"><span className="font-semibold">{item.requesterName}</span> requested editing access for <span className="font-semibold">{item.email}</span> <span className="text-vs-muted">· <span className="font-mono">{item.projectName}</span></span></p>
        <GuestAccess runId={item.runId} invitationId={item.invitationId} adminRequest onGranted={access.refresh}/>
      </li>)}
      {data?.items.map(item=><li key={item.runId} className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-4 py-3 transition hover:bg-vs-hover">
        <span className="min-w-0 flex-1 basis-48 truncate text-[13px] font-medium text-vs-fg" title={item.title}>{item.title}</span>
        <span className="flex shrink-0 flex-wrap gap-3">
          {item.unread>0&&<Link className="text-vs-accent hover:underline" href={`/s/${item.sessionId}?run=${item.runId}&collaboration=feedback`}>{item.unread} unread feedback</Link>}
          {item.reviews>0&&<Link className="text-vs-accent hover:underline" href={`/s/${item.sessionId}?run=${item.runId}&collaboration=reviews`}>{item.reviews} review request{item.reviews===1?'':'s'}</Link>}
        </span>
      </li>)}
    </ul>
    {(accessOffset>0||access.data?.hasMore)&&<div className="flex gap-2 px-4 py-2.5"><GhostButton disabled={!accessOffset} onClick={()=>setAccessOffset(Math.max(0,accessOffset-50))}>Previous access requests</GhostButton><GhostButton disabled={!access.data?.hasMore} onClick={()=>setAccessOffset(accessOffset+50)}>More access requests</GhostButton></div>}
    {(offset>0||data?.hasMore)&&<div className="flex gap-2 px-4 py-2.5"><GhostButton disabled={!offset} onClick={()=>setOffset(Math.max(0,offset-50))}>Previous</GhostButton><GhostButton disabled={!data?.hasMore} onClick={()=>setOffset(offset+50)}>Next</GhostButton></div>}
  </section>;
}
