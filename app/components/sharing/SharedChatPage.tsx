"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { SharedChat, SharedComment } from "../../lib/sharing/types";
import { sharedChatApi, sharedChatPath, SharingRequestError, sharingRequest } from "../../lib/sharing/client";
import { Markdown } from "../workspace/Markdown";
import { ErrorNote, GhostButton, inputClass, PrimaryButton } from "../ui/Modal";
import { BriefingCard } from "../collaboration/BriefingCard";

function savedToken(runId:string) {
  const key=`shared-chat-invite:${runId}`;
  const token=new URLSearchParams(location.hash.slice(1)).get("invite");
  try {if(token)sessionStorage.setItem(key,token);return token??sessionStorage.getItem(key);} catch{return token;}
}
/** "Anyone with the link" token, kept for this tab so signing in to comment does not lose it. */
function savedLink(runId:string) {
  const key=`shared-chat-link:${runId}`;
  const token=new URLSearchParams(location.hash.slice(1)).get("link");
  try {if(token)sessionStorage.setItem(key,token);return token??sessionStorage.getItem(key);} catch{return token;}
}
const linkHeaders=(link:string|null):HeadersInit|undefined=>link?{"x-chat-link":link}:undefined;
export function SharedChatPage({runId}:{runId:string}) {
  const [chat,setChat]=useState<SharedChat|null>(null);
  const [error,setError]=useState<string|null>(null);
  const [signIn,setSignIn]=useState(false);
  const [loading,setLoading]=useState(true);
  const [revision,setRevision]=useState(0);
  const [draft,setDraft]=useState("");
  const [sending,setSending]=useState(false);
  const [olderBusy,setOlderBusy]=useState(false);
  const after=useRef(0);
  const requestId=useRef<{id:string;body:string}|null>(null);
  const link=useRef<string|null>(null);
  const endpoint=sharedChatApi(runId);
  const mergeComments=(old:SharedComment[],fresh:SharedComment[])=>Array.from(new Map([...old,...fresh].map(c=>[c.id,c])).values()).sort((a,b)=>Date.parse(a.createdAt)-Date.parse(b.createdAt)||a.id.localeCompare(b.id));

  useEffect(()=>{
    const invitationChanged=()=>{const hash=new URLSearchParams(location.hash.slice(1));if(hash.has('invite')||hash.has('link')){after.current=0;setChat(null);setLoading(true);setRevision(value=>value+1);}};
    window.addEventListener('hashchange',invitationChanged);
    return()=>window.removeEventListener('hashchange',invitationChanged);
  },[runId]);

  useEffect(()=>{
    let disposed=false,working=false;
    let timer:ReturnType<typeof setTimeout>|undefined;
    let active:AbortController|undefined;
    const token=savedToken(runId);
    link.current=savedLink(runId);
    let accepted=!token;
    async function refresh() {
      if(disposed||document.hidden||working)return;
      working=true;active=new AbortController();
      const signal=AbortSignal.any([active.signal,AbortSignal.timeout(15_000)]);
      let more=false,stopped=false;
      try {
        if(!accepted) {
          await sharingRequest(endpoint,{method:"POST",body:JSON.stringify({token}),signal});
          accepted=true;
          if(disposed)return;
          try{sessionStorage.removeItem(`shared-chat-invite:${runId}`);}catch{}
          history.replaceState(null,"",sharedChatPath(runId)+(link.current?`#link=${encodeURIComponent(link.current)}`:""));
        }
        const data=await sharingRequest<SharedChat>(`${endpoint}?after=${after.current}`,{signal,headers:linkHeaders(link.current)});
        if(disposed)return;
        after.current=data.messages.at(-1)?.seq??after.current;
        more=data.hasMore;
        setChat(previous=>({...data,messages:Array.from(new Map([...(previous?.messages??[]),...data.messages].map(m=>[m.id,m])).values()),comments:mergeComments(previous?.comments??[],data.comments),commentsHaveMore:previous?.commentsHaveMore===false?false:data.commentsHaveMore}));
        setError(null);setSignIn(false);
      } catch(cause) {
        if(disposed||active.signal.aborted)return;
        setError(cause instanceof Error?cause.message:"Couldn’t load this chat. Try again.");
        if(cause instanceof SharingRequestError&&[401,403,404].includes(cause.status)) {
          setChat(null);after.current=0;stopped=true;setSignIn(cause.status===401);
        }
      } finally {
        working=false;
        if(!disposed){setLoading(false);if(!stopped&&!document.hidden)timer=setTimeout(()=>void refresh(),more?250:10_000);}
      }
    }
    const visibility=()=>{clearTimeout(timer);if(document.hidden)active?.abort();else void refresh();};
    document.addEventListener("visibilitychange",visibility);
    void refresh();
    return()=>{disposed=true;clearTimeout(timer);active?.abort();document.removeEventListener("visibilitychange",visibility);};
  },[endpoint,runId,revision]);

  async function comment(event:React.FormEvent) {
    event.preventDefault();if(sending||!draft.trim())return;
    const body=draft.trim();
    if(requestId.current?.body!==body)requestId.current={id:crypto.randomUUID(),body};
    setSending(true);setError(null);
    try {
      const saved=await sharingRequest<SharedComment>(`${endpoint}/comments`,{method:"POST",body:JSON.stringify(requestId.current),headers:linkHeaders(link.current)});
      setChat(previous=>previous?{...previous,comments:mergeComments(previous.comments,[saved])}:null);
      setDraft("");requestId.current=null;
    } catch(cause){
      setError(cause instanceof Error?cause.message:"Couldn’t post your comment. Your text is still here.");
      if(cause instanceof SharingRequestError&&[401,403].includes(cause.status)){setChat(null);after.current=0;setSignIn(cause.status===401);}
    }finally{setSending(false);}
  }
  async function olderComments() {
    if(!chat?.comments.length||olderBusy)return;setOlderBusy(true);
    try{
      const data=await sharingRequest<SharedChat>(`${endpoint}?after=${after.current}&commentsBefore=${encodeURIComponent(chat.comments[0].id)}`,{headers:linkHeaders(link.current)});
      setChat(previous=>previous?{...previous,comments:mergeComments(data.comments,previous.comments),commentsHaveMore:data.commentsHaveMore}:null);
    }catch(cause){setError(cause instanceof Error?cause.message:"Couldn’t load older comments.");if(cause instanceof SharingRequestError&&[401,403,404].includes(cause.status)){setChat(null);after.current=0;setSignIn(cause.status===401);}}
    finally{setOlderBusy(false);}
  }
  const next=encodeURIComponent(sharedChatPath(runId));
  return <main className="app-page vs-scroll h-dvh overflow-y-auto bg-vs-editor text-vs-fg"><div className="mx-auto max-w-4xl space-y-6 px-5 py-6 sm:px-8">
    <nav className="flex flex-wrap gap-4 text-sm text-vs-muted">{chat&&chat.signedIn===false?<><Link href="/">Multicode AI</Link><Link href={`/login?next=${next}`}>Sign in</Link></>:<><Link href="/workspace">Workspace</Link><Link href="/shared">Shared chats</Link></>}</nav>
    {loading&&!chat?<p role="status">Opening shared chat…</p>:null}
    {error&&<ErrorNote>{error}</ErrorNote>}
    {!chat&&!loading&&<section className="space-y-4 rounded-2xl border border-vs-border bg-vs-panel p-6"><h1 className="text-xl font-semibold">{signIn?"You’re invited to a conversation":"This chat needs an invitation"}</h1><p className="text-sm leading-6 text-vs-muted">Sign in with the email the host invited. You don’t need to create an organization, add a project, or connect a computer.</p><div className="flex flex-wrap gap-3"><Link className="rounded-lg bg-vs-accent px-4 py-2 text-sm text-vs-accent-fg" href={`/login?next=${next}`}>Sign in</Link><Link className="rounded-lg border border-vs-border px-4 py-2 text-sm" href={`/login?mode=signup&next=${next}`}>Create account</Link><GhostButton onClick={()=>{setLoading(true);setRevision(v=>v+1);}}>Try again</GhostButton></div><p className="text-xs text-vs-muted">Using another account? Choose Sign in and use the email the host invited. Keep your original invitation link if your browser blocks temporary storage.</p></section>}
    {chat&&<>
      {chat.workspacePath&&<div className="rounded-xl border border-vs-border p-4 text-sm"><p className="mb-2">You have workspace access. AI execution requires editing permission and a connected computer; accepting a handoff is a separate step.</p><Link className="text-vs-accent underline" href={chat.workspacePath}>Open workspace</Link></div>}
      <header className="space-y-2"><p className="text-sm text-vs-muted">Host: {chat.hostName} · {chat.role==="viewer"?"Can view":chat.role==="manager"?"Host":"Can comment"}{chat.viaLink?" · anyone with the link":""}</p><h1 className="break-words text-2xl font-semibold">{chat.title}</h1><p className="text-sm leading-6 text-vs-muted">You’re viewing this conversation only. Comments are a discussion with the host; they don’t send instructions to AI or change files.</p></header>
      {!chat.viaLink&&<BriefingCard key={runId} runId={runId} expanded />}
      <section aria-label="Shared conversation" className="space-y-6">{!chat.messages.length&&<p className="text-sm text-vs-muted">There aren’t any messages yet.</p>}{chat.messages.map(message=><article key={message.id} className={`min-w-0 rounded-xl p-4 ${message.role==="user"?"ml-4 border border-vs-border bg-vs-panel sm:ml-12":""}`}><p className="mb-2 text-xs text-vs-muted">{message.role==="agent"?"AI":message.authorName??"Human"}</p><Markdown text={message.body}/></article>)}{chat.hasMore&&<p role="status" className="text-sm text-vs-muted">Loading more messages…</p>}</section>
      <section aria-label="Comments" className="space-y-4 border-t border-vs-border pt-6"><h2 className="text-lg font-semibold">Comments</h2>{chat.commentsHaveMore&&<GhostButton disabled={olderBusy} onClick={()=>void olderComments()}>{olderBusy?"Loading…":"Load earlier comments"}</GhostButton>}{chat.comments.map(item=><article key={item.id} className="rounded-xl border border-vs-border bg-vs-panel p-4"><p className="mb-2 text-sm font-medium">{item.authorName}</p><p className="whitespace-pre-wrap break-words text-sm leading-6">{item.body}</p></article>)}{!chat.comments.length&&<p className="text-sm text-vs-muted">No comments yet.</p>}
        {chat.role!=="viewer"&&chat.signedIn===false?<p className="rounded-xl border border-vs-border p-4 text-sm text-vs-muted">Anyone with this link can comment. <Link className="text-vs-accent underline" href={`/login?next=${next}`}>Sign in</Link> to join the discussion.</p>:chat.role!=="viewer"?<form onSubmit={comment} className="space-y-3"><label htmlFor="shared-comment" className="text-sm font-medium">Add a comment</label><textarea id="shared-comment" value={draft} onChange={e=>setDraft(e.target.value)} maxLength={8000} rows={3} className={`${inputClass} resize-y`} placeholder="Share a question or feedback with the host…"/><PrimaryButton type="submit" disabled={sending||!draft.trim()}>{sending?"Posting…":"Post comment"}</PrimaryButton></form>:<p className="rounded-xl border border-vs-border p-4 text-sm text-vs-muted">You have view-only access. Ask the host for comment permission to join the discussion.</p>}
      </section>
    </>}
  </div></main>;
}

export function SharedChatsList() {
  const [chats,setChats]=useState<{id:string;title:string;hostName:string}[]|null>(null);
  const [error,setError]=useState<string|null>(null);
  const [version,setVersion]=useState(0);
  const load=()=>setVersion(value=>value+1);
  useEffect(()=>{
    const controller=new AbortController();
    void sharingRequest<{chats:NonNullable<typeof chats>}>("/api/shared-chats",{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15_000)])})
      .then(result=>{if(!controller.signal.aborted){setChats(result.chats);setError(null);}})
      .catch(cause=>{if(!controller.signal.aborted)setError(cause instanceof Error?cause.message:"Couldn’t load shared chats.");});
    return()=>controller.abort();
  },[version]);
  return <main className="app-page vs-scroll h-dvh overflow-y-auto p-5 text-vs-fg sm:p-10"><div className="mx-auto max-w-3xl space-y-5"><Link href="/workspace" className="text-sm text-vs-muted">← Workspace</Link><h1 className="text-2xl font-semibold">Shared with me</h1><p className="text-sm text-vs-muted">Conversations you’ve joined by invitation. No organization or project membership needed.</p>{error&&<><ErrorNote>{error}</ErrorNote><GhostButton onClick={()=>void load()}>Try again</GhostButton><a href="/login?next=%2Fshared" className="ml-4 text-sm text-vs-accent">Sign in</a></>}{chats?.map(chat=><Link key={chat.id} href={sharedChatPath(chat.id)} className="block rounded-xl border border-vs-border bg-vs-panel p-4 hover:bg-vs-hover"><p className="break-words font-medium">{chat.title}</p><p className="text-sm text-vs-muted">Host: {chat.hostName}</p></Link>)}{chats?.length===0&&<p className="text-sm text-vs-muted">No active shared chats yet. Open an invitation link from a host to join one.</p>}{!chats&&!error&&<p role="status">Loading shared chats…</p>}</div></main>;
}
