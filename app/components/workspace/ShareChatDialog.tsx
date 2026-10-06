"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { AgentRun } from "../../lib/ai/runs";
import type { ChatInvitation, ChatShareRole } from "../../lib/sharing/types";
import { sharedChatApi, sharedChatPath, sharingRequest } from "../../lib/sharing/client";
import { ErrorNote, Field, GhostButton, inputClass, Modal, PrimaryButton } from "../ui/Modal";
import { useToast } from "../ui/Toast";
import { ComposerPicker } from "./ComposerPicker";

export function ShareChatDialog({run,onClose}:{run:AgentRun;onClose:()=>void}) {
  const {notify}=useToast();
  const [email,setEmail]=useState("");
  const [role,setRole]=useState<ChatShareRole>("viewer");
  const [invitations,setInvitations]=useState<ChatInvitation[]>([]);
  const [link,setLink]=useState<{id:string;url:string}|null>(null);
  const [error,setError]=useState<string|null>(null);
  const [busy,setBusy]=useState(false);
  const [loading,setLoading]=useState(true);
  const [canManage,setCanManage]=useState(false);
  const [now,setNow]=useState(()=>Date.now());
  const endpoint=`${sharedChatApi(run.id)}/invitations`;
  useEffect(()=>{
    const controller=new AbortController();
    void sharingRequest<{invitations:ChatInvitation[]}>(endpoint,{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15_000)])})
      .then(data=>{if(!controller.signal.aborted){setInvitations(data.invitations);setCanManage(true);setNow(Date.now());}})
      .catch(cause=>{if(!controller.signal.aborted)setError(cause instanceof Error?cause.message:"Couldn’t load invitations.");})
      .finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return()=>controller.abort();
  },[endpoint]);
  async function create(event:React.FormEvent) {
    event.preventDefault();if(busy)return;
    setBusy(true);setError(null);
    try {
      const result=await sharingRequest<{invitation:ChatInvitation;token:string}>(endpoint,{method:"POST",body:JSON.stringify({email,role})});
      setInvitations(items=>[result.invitation,...items.map(item=>item.email.toLowerCase()===result.invitation.email.toLowerCase()?{...item,revokedAt:new Date().toISOString()}:item)]);
      setLink({id:result.invitation.id,url:`${location.origin}${sharedChatPath(run.id)}#invite=${encodeURIComponent(result.token)}`});
      notify({title:"Invitation ready",description:"Copy the link and send it to the person you invited."});
    } catch(cause) {setError(cause instanceof Error?cause.message:"Couldn’t create the invitation.");}
    finally{setBusy(false);}
  }
  async function revoke(id:string) {
    if(busy)return;setBusy(true);setError(null);
    try{
      await sharingRequest(endpoint,{method:"DELETE",body:JSON.stringify({id})});
      setInvitations(items=>items.map(item=>item.id===id?{...item,revokedAt:new Date().toISOString()}:item));
      if(link?.id===id)setLink(null);
      notify({title:"Access removed",description:"This invitation no longer opens the chat, including for someone who already joined."});
    }catch(cause){setError(cause instanceof Error?cause.message:"Couldn’t remove access. Try again.");}
    finally{setBusy(false);}
  }
  return <Modal title={`Share “${run.title??"AI chat"}”`} description="Invite someone to this conversation, even if they aren’t on your team." onClose={onClose} footer={<GhostButton onClick={onClose}>Done</GhostButton>}>
    <p className="text-sm leading-6 text-vs-muted">They can read this chat’s existing and future human/AI messages, including any code or sensitive text in those messages. Other chats, files, tools, and workspace settings stay private.</p>
    <Link href={sharedChatPath(run.id)} target="_blank" rel="noopener noreferrer" className="inline-block text-sm text-vs-accent underline underline-offset-4">Preview shared chat & reply to comments</Link>
    <form onSubmit={create} className="space-y-4">
      <Field label="Recipient’s email"><input required type="email" maxLength={254} value={email} onChange={e=>setEmail(e.target.value)} className={inputClass} placeholder="teammate@example.com" /></Field>
      <ComposerPicker label="Guest permission" value={role} onChange={value=>setRole(value as ChatShareRole)} placement="auto" className="connections-project-picker" options={[
        {id:"viewer",label:"Can view",description:"Read this conversation and its comments."},
        {id:"commenter",label:"Can comment",description:"Read and discuss. Comments do not run AI or change files."},
      ]}/>
      <p className="text-sm leading-5 text-vs-muted">Only this email can accept the link. Access ends in 7 days or when you remove it. A new invitation replaces this person’s previous access.</p>
      <PrimaryButton type="submit" disabled={busy||loading||!canManage}>{busy?"Saving…":"Create invitation link"}</PrimaryButton>
    </form>
    {link&&<div className="space-y-2 rounded-xl border border-vs-border p-3"><label className="block text-sm font-medium" htmlFor="chat-invite-link">Invitation link — send it to your guest</label><input id="chat-invite-link" readOnly value={link.url} onFocus={e=>e.target.select()} className={`${inputClass} font-mono text-xs`}/><GhostButton onClick={()=>{void navigator.clipboard.writeText(link.url).then(()=>notify({title:"Link copied"})).catch(()=>setError("Couldn’t copy automatically. Select the link above and copy it."));}}>Copy link</GhostButton></div>}
    {error&&<ErrorNote>{error}</ErrorNote>}
    {loading?<p className="text-sm text-vs-muted">Loading invitations…</p>:<ul className="space-y-2" aria-label="Chat invitations">{invitations.map(item=>{
      const ended=!!item.revokedAt||Date.parse(item.expiresAt)<=now;
      return <li key={item.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-vs-border p-3 text-sm"><div className="min-w-0 flex-1"><p className="break-all">{item.email}</p><p className="text-xs text-vs-muted">{item.revokedAt?"Access removed":ended?"Expired":`${item.role==="commenter"?"Can comment":"Can view"} · ${item.acceptedAt?"Joined":"Waiting to join"} · ends ${new Date(item.expiresAt).toLocaleDateString()}`}</p></div>{!ended&&<GhostButton disabled={busy} onClick={()=>void revoke(item.id)}>Remove access</GhostButton>}</li>;
    })}</ul>}
  </Modal>;
}
