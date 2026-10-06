"use client";
import { openUserStream } from "../../lib/events/shared-client";

import { openSessionStream } from "../../lib/events/client";
import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { isSelfAssignment, taskStatuses, type RoomTask, type TaskMember, type TaskStatus } from "../../lib/tasks/types";

const labels: Record<TaskStatus,string> = {open:"To do",in_progress:"In progress",done:"Done",cancelled:"Cancelled"};
async function request<T>(url:string, init?:RequestInit):Promise<T> {
  const response = await fetch(url,{...init,cache:"no-store",headers:{"content-type":"application/json"}});
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "Could not load tasks.");
  return data;
}

/** Same durable assignments in their source chat and the assignee's inbox. */
export function TaskPanel({userId,sessionId,runId,canAssign=false,showAssignAction=true,hideWhenEmpty=false,refreshVersion=0}: {
  userId:string; sessionId?:string; runId?:string; canAssign?:boolean; showAssignAction?:boolean; hideWhenEmpty?:boolean; refreshVersion?:number;
}) {
  const [tasks,setTasks] = useState<RoomTask[]>([]);
  const [members,setMembers] = useState<TaskMember[]>([]);
  const [loading,setLoading] = useState(true);
  const [error,setError] = useState<string|null>(null);
  const [notice,setNotice] = useState("");
  const [assigning,setAssigning] = useState(false);
  const [person,setPerson] = useState("");
  const [body,setBody] = useState("");
  const [busy,setBusy] = useState(false);
  const [offset,setOffset] = useState(0);
  const [hasMore,setHasMore] = useState(false);
  const generation = useRef(0);
  const mutation = useRef(false);
  const requestsInFlight = useRef(0);
  const pending = useRef<{payload:string;id:string}|null>(null);
  const pickerId = useId();
  const assignees = members.filter(member => !isSelfAssignment(userId, member.userId));
  const url = `/api/tasks?offset=${offset}&members=${assigning ? "1" : "0"}${sessionId && runId ? `&sessionId=${encodeURIComponent(sessionId)}&runId=${encodeURIComponent(runId)}` : ""}`;
  const refresh = useCallback(async () => {
    const version = ++generation.current;
    requestsInFlight.current++;
    try { await request<{tasks:RoomTask[];members:TaskMember[];hasMore:boolean}>(url).then(data => {
      if (version !== generation.current) return;
      setTasks(data.tasks); setMembers(data.members); setHasMore(data.hasMore); setError(null);
      setLoading(false);
    },cause => {
      if (version === generation.current) { setTasks([]); setMembers([]); setError(cause instanceof Error ? cause.message : "Could not load tasks."); }
      if (version === generation.current) setLoading(false);
    }); } finally { requestsInFlight.current--; }
  },[url]);
  useEffect(() => {
    const counter = generation;
    void refresh();
    const poll = () => { if (!document.hidden && !mutation.current) void refresh(); };
    const stream = sessionId ? openSessionStream(sessionId, { onTasksChanged: poll, onMembersChanged: poll, onRoleChanged: poll, onStatus: connected => { if (connected) poll(); } }) : openUserStream(type => { if (type === "tasks.changed") poll(); }, poll);
    window.addEventListener("focus",poll);
    return () => { counter.current++; stream.close(); window.removeEventListener("focus",poll); };
  },[refresh,refreshVersion,sessionId]);

  async function assign(event:React.FormEvent) {
    event.preventDefault();
    if (mutation.current) return;
    const member = assignees.find(m => `@${m.handle}`.toLowerCase() === person.trim().toLowerCase());
    if (!member) { setError("Choose another room member using their @handle."); return; }
    const payload = JSON.stringify({sessionId,runId,assigneeId:member.userId,body:body.trim()});
    if (pending.current?.payload !== payload) pending.current = {payload,id:crypto.randomUUID()};
    mutation.current=true; setBusy(true); setError(null); generation.current++;
    try {
      await request("/api/tasks",{method:"POST",body:JSON.stringify({...JSON.parse(payload),id:pending.current.id})});
      setBody(""); setPerson(""); pending.current=null; setAssigning(false);
      setNotice(`Task assigned to ${member.displayName}.`);
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not assign task."); }
    finally { mutation.current=false; setBusy(false); }
  }

  async function changeStatus(id:string,status:TaskStatus) {
    if (mutation.current) return;
    mutation.current=true; setBusy(true); setError(null); generation.current++;
    try { await request(`/api/tasks/${id}`,{method:"PATCH",body:JSON.stringify({status})}); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not update task."); }
    finally { mutation.current=false; setBusy(false); }
  }

  if (hideWhenEmpty && !loading && !error && tasks.length === 0) return null;

  return <section aria-label={runId ? "Chat tasks" : "My tasks"} className="my-5 rounded-2xl border border-vs-border bg-vs-panel p-4 text-xs">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-sm font-semibold">{runId ? "Chat tasks" : "My tasks"}</h2>
      {runId && canAssign && showAssignAction && <button type="button" aria-expanded={assigning} onClick={() => setAssigning(!assigning)} className="rounded border border-vs-border px-2.5 py-1 text-vs-accent">@ Assign task</button>}
      {!runId && <span className="text-[11px] text-vs-muted">Assigned to you across your rooms</span>}
    </div>
    {assigning && <form onSubmit={assign} className="mt-3 space-y-3">
      <label className="block">Assign to another room member
        <input required autoFocus disabled={busy} list={pickerId} value={person} onChange={e => setPerson(e.target.value)} placeholder="@handle" className="mt-1 block w-full rounded border border-vs-border bg-vs-editor p-2" />
      </label>
      <datalist id={pickerId}>{assignees.map(m => <option key={m.userId} value={`@${m.handle}`}>{m.displayName}</option>)}</datalist>
      <label className="block">What should they do?
        <textarea required disabled={busy} value={body} maxLength={4000} onChange={e => setBody(e.target.value)} placeholder="Please review the code changes in this chat…" rows={3} className="mt-1 block w-full rounded border border-vs-border bg-vs-editor p-2" />
      </label>
      <p className="text-xs text-vs-muted">This creates a task in their dashboard and links to this chat.</p>
      <button disabled={busy || !body.trim() || !person.trim()} className="rounded bg-vs-accent px-3 py-2 text-vs-accent-fg disabled:opacity-40">{busy ? "Assigning…" : "Create task"}</button>
    </form>}
    {notice && <p role="status" className="mt-2 text-vs-accent">{notice}</p>}
    {error && <p role="alert" className="mt-2 text-vs-danger">{error} <button type="button" onClick={() => void refresh()} className="underline">Refresh</button></p>}
    {loading ? <p className="mt-3 text-vs-muted">Loading tasks…</p> : !error && tasks.length === 0 ? <p className="mt-3 text-vs-muted">{runId ? "No tasks in this chat yet." : "No tasks assigned to you yet."}</p> : null}
    <ul className="mt-2 space-y-3">{tasks.map(task => <li key={task.id} className="rounded-xl border border-vs-border bg-vs-editor/50 p-4">
      <p className="text-xs text-vs-muted">{task.creatorName} → <span className="text-vs-accent">@{task.assigneeHandle}</span> · {new Date(task.createdAt).toLocaleDateString()}</p>
      <p className="mt-2 whitespace-pre-wrap break-words">{task.body}</p>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        {!runId && <Link href={`/s/${task.sessionId}?run=${task.runId}`} className="text-vs-accent underline">{task.roomName} / {task.chatTitle}</Link>}
        {(task.assigneeId === userId || (canAssign && task.createdBy === userId)) ? <select aria-label={`Status for ${task.body.slice(0,60)}`} disabled={busy} value={task.status} onChange={e => void changeStatus(task.id,e.target.value as TaskStatus)} className="rounded border border-vs-border bg-vs-editor p-1">{taskStatuses.map(status => <option key={status} value={status}>{labels[status]}</option>)}</select> : <span>{labels[task.status]}</span>}
      </div>
    </li>)}</ul>
    {(offset > 0 || hasMore) && <div className="mt-3 flex gap-3"><button disabled={offset === 0 || busy} onClick={() => setOffset(Math.max(0,offset-50))}>Previous</button><button disabled={!hasMore || busy} onClick={() => setOffset(offset+50)}>Next</button></div>}
  </section>;
}
