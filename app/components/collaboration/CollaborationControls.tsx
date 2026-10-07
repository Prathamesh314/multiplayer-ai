"use client";
import { useState } from "react";
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

export function CollaborationInbox() {
  const [offset,setOffset]=useState(0);
  const [accessOffset,setAccessOffset]=useState(0);
  const access=useResource<{items:AccessRequest[];hasMore:boolean}>(`/api/collaboration/access-requests?offset=${accessOffset}`);
  const {data,error,refresh}=useResource<{items:InboxItem[];hasMore:boolean}>(`/api/collaboration/inbox?offset=${offset}`);
  return <section aria-label="Collaboration inbox" className="mt-5 space-y-3 rounded-2xl border border-vs-border bg-vs-panel p-4">
    <h2 className="text-sm font-semibold">Collaboration inbox</h2>
    {access.error&&<><ErrorNote>{access.error}</ErrorNote><GhostButton onClick={access.refresh}>Retry access requests</GhostButton></>}
    {access.data?.items.map(item=><div key={item.invitationId} className="space-y-2 rounded-xl border border-vs-border p-3 text-sm">
      <p><strong>{item.requesterName}</strong> requested editing access for <strong>{item.email}</strong> in {item.projectName}.</p>
      <GuestAccess runId={item.runId} invitationId={item.invitationId} adminRequest onGranted={access.refresh}/>
    </div>)}
    {(accessOffset>0||access.data?.hasMore)&&<div className="flex gap-2"><GhostButton disabled={!accessOffset} onClick={()=>setAccessOffset(Math.max(0,accessOffset-50))}>Previous access requests</GhostButton><GhostButton disabled={!access.data?.hasMore} onClick={()=>setAccessOffset(accessOffset+50)}>More access requests</GhostButton></div>}
    {error&&<><ErrorNote>{error}</ErrorNote><GhostButton onClick={refresh}>Retry inbox</GhostButton></>}
    {!data&&!error&&<p className="text-sm text-vs-muted">Loading conversations needing your attention…</p>}
    {data?.items.length===0&&access.data?.items.length===0&&<p className="text-sm text-vs-muted">You’re caught up. Guest replies, teammate reviews, and requests for access appear here.</p>}
    {data?.items.map(item=><div key={item.runId} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-vs-border p-3 text-sm"><span className="min-w-0 break-words font-medium">{item.title}</span><span className="flex flex-wrap gap-3">{item.unread>0&&<Link className="text-vs-accent underline" href={`/s/${item.sessionId}?run=${item.runId}&collaboration=feedback`}>{item.unread} unread feedback</Link>}{item.reviews>0&&<Link className="text-vs-accent underline" href={`/s/${item.sessionId}?run=${item.runId}&collaboration=reviews`}>{item.reviews} review request{item.reviews===1?'':'s'}</Link>}</span></div>)}
    {(offset>0||data?.hasMore)&&<div className="flex gap-2"><GhostButton disabled={!offset} onClick={()=>setOffset(Math.max(0,offset-50))}>Previous</GhostButton><GhostButton disabled={!data?.hasMore} onClick={()=>setOffset(offset+50)}>Next</GhostButton></div>}
  </section>;
}
