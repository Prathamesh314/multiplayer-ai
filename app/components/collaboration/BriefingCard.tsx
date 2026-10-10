"use client";
import { useState } from "react";
import { briefingFields, type Briefing, type BriefingBody, type BriefingField } from "../../lib/collaboration/types";
import { sharingRequest } from "../../lib/sharing/client";
import { ErrorNote, GhostButton, inputClass, PrimaryButton } from "../ui/Modal";
import { useResource } from "./useResource";

const labels: Record<BriefingField,string> = {goal:"Goal",decisions:"Accepted decisions",progress:"Recorded progress",blockers:"Blockers / checks",nextAction:"Next action"};
/** `bare` drops the disclosure chrome for hosts that supply their own heading,
 *  such as the chat header's briefing dialog. */
export function BriefingCard({runId,expanded=false,bare=false,onUseForHandoff}:{runId:string;expanded?:boolean;bare?:boolean;onUseForHandoff?:(note:string)=>void}) {
  const endpoint=`/api/chats/${encodeURIComponent(runId)}/briefing`;
  const {data,error,refresh}=useResource<Briefing>(endpoint,30_000);
  const [editing,setEditing]=useState<Briefing|null>(null);
  const [busy,setBusy]=useState(false),[failure,setFailure]=useState<string|null>(null),[notice,setNotice]=useState("");
  async function save() {
    if(!editing||busy)return;setBusy(true);setFailure(null);
    try{const {body,revision,fingerprint,sharedWithGuests}=editing;await sharingRequest(endpoint,{method:'PUT',body:JSON.stringify({body,revision,fingerprint,sharedWithGuests})});setEditing(null);setNotice('Briefing saved.');refresh();}
    catch(cause){setFailure(cause instanceof Error?cause.message:'Could not save. Your draft is still here.');}
    finally{setBusy(false);}
  }
  async function regenerate(keepEdits:boolean) {
    setBusy(true);setFailure(null);
    try{
      const latest=await sharingRequest<Briefing>(`${endpoint}?draft=1`);
      setEditing(previous=>keepEdits&&previous?{...latest,body:previous.body,sharedWithGuests:previous.sharedWithGuests}:latest);
      setNotice(keepEdits?'Sources refreshed. Check your draft against the updated evidence before saving.':'Draft rebuilt from recorded activity. Review and edit it before saving.');
    }catch(cause){setFailure(cause instanceof Error?cause.message:'Could not refresh the draft.');}
    finally{setBusy(false);}
  }
  if(!data)return <div className={bare?'text-sm text-vs-muted':'px-4 py-2 text-sm text-vs-muted'}>{error?<><ErrorNote>{error}</ErrorNote><GhostButton onClick={refresh}>Retry briefing</GhostButton></>:'Preparing conversation briefing…'}</div>;
  const current=editing??data;
  const change=(field:BriefingField,value:string)=>setEditing(previous=>previous?{...previous,body:{...previous.body,[field]:value} as BriefingBody}:null);
  const detail=<div className={bare?'vs-scroll max-h-[60vh] space-y-3 overflow-y-auto pr-1 text-sm':'vs-scroll mt-3 max-h-[55vh] space-y-3 overflow-y-auto pr-1'}>
      <p className="text-xs leading-5 text-vs-muted">{bare?`${data.revision?'Saved by '+data.updatedBy:'Draft from recorded activity'}. Saved changes and accepted decisions are identified separately.`:'A starting point for joining the work. AI reports are unverified; saved changes and accepted decisions are identified separately.'}</p>
      {data.stale&&<p role="status" className="text-vs-warn">The conversation or saved work has changed since this briefing. Check current sources before acting.</p>}
      {briefingFields.map(field=><div key={field}><label className="mb-1 block font-medium" htmlFor={editing?`briefing-${runId}-${field}`:undefined}>{labels[field]}</label>{editing?<textarea id={`briefing-${runId}-${field}`} rows={field==='goal'?2:3} maxLength={6000} value={current.body[field]} onChange={e=>change(field,e.target.value)} className={inputClass}/>:<p className="whitespace-pre-wrap break-words leading-6 text-vs-muted">{current.body[field]}</p>}</div>)}
      {current.headSha&&<p className="text-xs text-vs-muted">Saved version <code>{current.headSha.slice(0,8)}</code></p>}
      <details><summary className="cursor-pointer text-vs-accent">Source evidence · {current.sources.length}</summary><ul className="mt-2 space-y-2">{current.sources.map((source,index)=><li key={`${source.kind}-${source.id}-${index}`} className="rounded-lg border border-vs-border p-2"><p className="text-xs font-medium">{source.label} · <code>{source.id.slice(0,8)}</code></p><p className="mt-1 whitespace-pre-wrap break-words text-xs leading-5 text-vs-muted">{source.excerpt}</p></li>)}</ul></details>
      {editing&&data.canPublish&&<label className="flex items-start gap-2 text-xs leading-5"><input type="checkbox" className="mt-1" checked={editing.sharedWithGuests} onChange={e=>setEditing({...editing,sharedWithGuests:e.target.checked})}/>Share this briefing and its evidence with invited guests. This can include workspace decisions and saved-change details. Only the chat host can publish it.</label>}
      {data.sharedWithGuests&&!data.canPublish&&<p className="text-xs text-vs-muted">The host manages this briefing because it is shared with guests.</p>}
      {(failure||error)&&<ErrorNote>{failure??error}</ErrorNote>}{notice&&<p role="status" className="text-xs text-vs-muted">{notice}</p>}
      <div className="flex flex-wrap gap-2">
        {data.canEdit&&(editing?<><PrimaryButton disabled={busy} onClick={()=>void save()}>{busy?'Saving…':'Save briefing'}</PrimaryButton><GhostButton disabled={busy} onClick={()=>void regenerate(true)}>Refresh evidence, keep draft</GhostButton><GhostButton disabled={busy} onClick={()=>void regenerate(false)}>Replace draft from sources</GhostButton><GhostButton disabled={busy} onClick={()=>{setEditing(null);setFailure(null);setNotice('');}}>Cancel edits</GhostButton></>:<GhostButton onClick={()=>{setEditing(data);setFailure(null);setNotice('');}}>Edit briefing</GhostButton>)}
        {onUseForHandoff&&<GhostButton disabled={!!editing} onClick={()=>onUseForHandoff(`Goal: ${data.body.goal.slice(0,220)}\nNext: ${data.body.nextAction.slice(0,320)}\nChecks: ${data.body.blockers.slice(0,260)}`)}>Use briefing in handoff note</GhostButton>}
      </div>
    </div>;
  if(bare)return detail;
  return <details open={expanded||!!editing||undefined} className="shrink-0 border-b border-vs-border bg-vs-panel/40 px-4 py-3 text-sm">
    <summary className="cursor-pointer"><span className="font-semibold">Conversation briefing</span><span className="ml-2 text-xs text-vs-muted">{data.revision?'Saved by '+data.updatedBy:'Draft from recorded activity'}{data.stale?' · Needs updating':''}</span><span className="mt-1 block truncate text-vs-muted">{data.body.goal}</span></summary>
    {detail}
  </details>;
}
