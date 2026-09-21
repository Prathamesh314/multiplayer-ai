"use client";

import { useEffect, useState } from "react";
import { Modal, GhostButton, PrimaryButton, ErrorNote, inputClass } from "../ui/Modal";

type Record = {
  id: string; kind: "fact" | "episode" | "procedure"; text: string;
  status: "proposed" | "approved" | "superseded" | "retracted";
  revision: number; stated_at: string; source_run_id: string | null;
  publish_gated: boolean; published_at: string | null; supersedes: string | null;
  source_turn_id: string | null; commit_sha: string | null;
};
type Detail = {
  nodes: Record[];
  edges: { id: string; from_id: string; relation: string; to_memory_id: string | null; commit_sha: string | null; path: string | null }[];
  events: { id: string; memory_id: string; to_status: string; created_at: string; reason: string }[];
  jobs: { operation: string; last_error: string | null }[];
  sources: { memory_id: string; body: string | null; author: string | null }[];
};

async function request<T>(url: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(url, { method, cache: "no-store", ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || "Could not load memories.");
  return value;
}

export function MemoryDialog({ roomId, readOnly, onClose, onOpenRun }: {
  roomId: string; readOnly: boolean; onClose: () => void; onOpenRun: (id: string) => void;
}) {
  const base = `/api/sessions/${roomId}/memories`;
  const [records,setRecords] = useState<Record[] | null>(null);
  const [cursor,setCursor] = useState<string | null>(null);
  const [selected,setSelected] = useState<string | null>(null);
  const [detail,setDetail] = useState<Detail | null>(null);
  const [error,setError] = useState<string | null>(null);
  const [busy,setBusy] = useState(false);
  const [version,setVersion] = useState(0);
  const [draft,setDraft] = useState("");
  const [kind,setKind] = useState<"fact" | "procedure">("fact");
  const [replacement,setReplacement] = useState("");
  const [implementation,setImplementation] = useState("");
  useEffect(() => {
    let cancelled = false;
    request<{ memories: Record[]; nextCursor: string | null }>(base).then(value => {
      if (!cancelled) { setRecords(value.memories);setCursor(value.nextCursor); }
    }).catch(cause => { if (!cancelled) { setRecords(null);setDetail(null);setError(cause.message); } });
    return () => { cancelled = true; };
  },[base,version]);
  useEffect(() => {
    let cancelled = false;
    if (selected) request<Detail>(`${base}/${selected}`).then(value => { if (!cancelled) setDetail(value); })
      .catch(cause => { if (!cancelled) { setDetail(null);setError(cause.message); } });
    return () => { cancelled = true; };
  },[base,selected,version]);
  const memory = detail?.nodes.find(row => row.id === selected);
  const source = detail?.sources.find(row => row.memory_id === selected);
  async function action(task: () => Promise<void>, refresh = true) {
    setBusy(true);setError(null);
    try { await task();if (refresh) setVersion(value => value+1); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not update memory."); }
    finally { setBusy(false); }
  }
  function select(id: string) { setDetail(null);setSelected(id);setReplacement("");setImplementation("");setDraft("");setError(null); }
  return <Modal title="Room memory" description="Review what this room remembers. Proposals need approval before they can guide future AI work." onClose={onClose} width="max-w-3xl">
    {error && <ErrorNote>{error}</ErrorNote>}
    <GhostButton disabled={busy} onClick={() => {setError(null);setVersion(v => v+1);}}>Refresh</GhostButton>
    {records === null && !error && <p role="status">Loading memories…</p>}
    {records?.length === 0 && <p className="text-sm text-vs-muted">Completed AI conversations will appear here. You can turn an exchange into a fact or procedure and review it before approval.</p>}
    <div className="grid gap-4 md:grid-cols-2">
      <div className="space-y-2">
        {records?.map(row => <button key={row.id} onClick={() => select(row.id)} aria-pressed={selected===row.id} className={`w-full rounded-lg border p-3 text-left ${selected===row.id ? "border-vs-accent" : "border-vs-border"}`}>
          <span className="text-xs capitalize text-vs-muted">{row.kind} · {row.status}</span>
          <span className="mt-1 block whitespace-pre-wrap break-words text-sm">{row.text.slice(0,160)}{row.text.length>160 ? "…" : ""}</span>
        </button>)}
        {cursor && <GhostButton disabled={busy} onClick={() => { void action(async () => {
          const value=await request<{memories:Record[];nextCursor:string|null}>(`${base}?before=${cursor}`);
          setRecords(previous => [...(previous??[]),...value.memories]);setCursor(value.nextCursor);
        }, false); }}>Load older memories</GhostButton>}
      </div>
      <div className="space-y-3" aria-live="polite">
        {selected && !detail && !error && <p>Loading evidence…</p>}
        {memory && <>
          <p className="text-sm capitalize">{memory.kind} · {memory.status} · {new Date(memory.stated_at).toLocaleDateString()}</p>
          <p className="whitespace-pre-wrap break-words text-sm">{memory.text}</p>
          {memory.status==='superseded' && <p className="text-sm text-vs-muted">This memory was replaced. Follow the replacement below to see the current decision.</p>}
          {memory.publish_gated && !memory.published_at && <p className="text-sm text-vs-muted">{memory.commit_sha ? 'Waiting for the source code to be published to the project.' : 'This older exchange has no verified source commit. Keep it as history, or record a new decision with source evidence.'}</p>}
          {source?.body && <details><summary className="cursor-pointer text-sm">Source evidence{source.author ? ` · ${source.author}` : ""}</summary><p className="mt-2 whitespace-pre-wrap break-words rounded border border-vs-border p-2 text-sm">{source.body}</p></details>}
          {memory.source_run_id && <GhostButton onClick={() => onOpenRun(memory.source_run_id!)}>Open source chat</GhostButton>}
          {!readOnly && memory.status==='proposed' && <>
            {memory.kind!=='episode' && <label className="block text-sm">Replaces an earlier decision (optional)
              <select value={replacement} onChange={event=>setReplacement(event.target.value)} className={inputClass}>
                <option value="">No replacement</option>
                {records?.filter(row=>row.status==='approved' && row.kind===memory.kind && row.id!==memory.id).map(row=><option key={row.id} value={row.id}>{row.text.slice(0,100)}</option>)}
              </select>
            </label>}
            <PrimaryButton disabled={busy || (memory.publish_gated && !memory.published_at)} onClick={()=>{void action(async()=>{
              await request(`${base}/${memory.id}`,"PATCH",{status:'approved',revision:memory.revision,...(replacement?{supersedes:replacement}:{})});
            });}}>Approve{replacement ? " and replace" : ""}</PrimaryButton>
          </>}
          {!readOnly && ['proposed','approved'].includes(memory.status) && <GhostButton disabled={busy} onClick={()=>{void action(async()=>{
            await request(`${base}/${memory.id}`,"PATCH",{status:'retracted',revision:memory.revision});
          });}}>Retract memory</GhostButton>}
          {!readOnly && memory.kind==='episode' && ['proposed','approved'].includes(memory.status) && <form className="space-y-2" onSubmit={event=>{
            event.preventDefault();void action(async()=>{const value=await request<{memory:Record}>(base,"POST",{kind,text:draft,sourceMemoryId:memory.id});select(value.memory.id);});
          }}>
            <label className="block text-sm">Create a reusable memory
              <select value={kind} onChange={event=>setKind(event.target.value as typeof kind)} className={inputClass}><option value="fact">Fact / decision</option><option value="procedure">Procedure</option></select>
            </label>
            <label className="block text-sm">What should the team remember?<textarea required maxLength={4000} value={draft} onChange={event=>setDraft(event.target.value)} className={inputClass}/></label>
            <PrimaryButton type="submit" disabled={busy || !draft.trim()}>Save proposal</PrimaryButton>
          </form>}
          {!readOnly && memory.kind!=='episode' && memory.status==='approved' && <div className="space-y-2">
            <label className="block text-sm">Link the implementation
              <select className={inputClass} value={implementation} onChange={event=>setImplementation(event.target.value)}>
                <option value="">Choose an approved code change</option>
                {records?.filter(row=>row.kind==='episode' && row.status==='approved' && row.commit_sha && row.source_turn_id).map(row=><option key={row.id} value={row.source_turn_id!}>{row.commit_sha!.slice(0,8)} · {row.text.slice(0,80)}</option>)}
              </select>
            </label>
            <GhostButton disabled={busy || !implementation} onClick={()=>{void action(async()=>{await request(`${base}/${memory.id}/edges`,"POST",{relation:'implemented_by',turnId:implementation});});}}>Link code change</GhostButton>
          </div>}
          {detail?.edges.filter(edge=>edge.from_id===memory.id || edge.to_memory_id===memory.id).map(edge=>{
            const related=edge.from_id===memory.id ? edge.to_memory_id : edge.from_id;
            return <p key={edge.id} className="break-words text-xs text-vs-muted">{edge.relation==='supersedes' && edge.to_memory_id===memory.id ? 'Replaced by' : edge.relation.replaceAll('_',' ')}{related ? <> · <button className="underline" onClick={()=>select(related)}>View related memory</button></> : ` · ${edge.path??edge.commit_sha?.slice(0,12)??'Source message'}`}</p>;
          })}
          <details><summary className="cursor-pointer text-sm">Review history</summary>{detail?.events.filter(event=>event.memory_id===memory.id).map(event=><p key={event.id} className="mt-2 text-xs text-vs-muted">{new Date(event.created_at).toLocaleString()} · {event.to_status} · {event.reason}</p>)}</details>
          {!!detail?.jobs.length && <p className="text-xs text-vs-muted">{detail.jobs.some(job=>job.last_error) ? 'Some background processing is waiting to retry. Saved evidence is available.' : 'Background processing pending. Saved evidence is available.'}</p>}
        </>}
      </div>
    </div>
  </Modal>;
}
