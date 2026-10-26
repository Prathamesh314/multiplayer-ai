"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentRun } from "../../lib/ai/runs";
import type { SavedCheckpoint } from "../../lib/runner/checkpoints";
import type { AiRunEvent } from "../../lib/ai/run-events";
import { openSessionStream } from "../../lib/events/client";
import { Modal } from "../ui/Modal";
import { ComposerPicker } from "./ComposerPicker";
type Turn = { id: string; status: string; syncedAt: string | null; sequence: number };
type History = { turns: Turn[]; snapshots: SavedCheckpoint[]; selectedSnapshotId: string | null };
const button = "rounded-lg border border-vs-border px-3 py-1.5 text-xs hover:bg-vs-hover disabled:opacity-50";
/**
 * The chat's synchronized activity and checkpoints, opened from the chat's
 * nav. It keeps itself current while closed, so `onStatus` can tell the nav
 * when activity last synced and whether a checkpoint is chosen for next turn.
 */
export function WorkspaceHistory({ run, userId, open, onClose, onStatus }: {
  run: AgentRun; userId: string | null; open: boolean; onClose: () => void;
  onStatus?: (status: { hint: string; checkpointSelected: boolean }) => void;
}) {
  const [data, setData] = useState<History | null>(null), [error, setError] = useState("");
  const [turn, setTurn] = useState(""), [after, setAfter] = useState(0), [activity, setActivity] = useState<AiRunEvent[]>([]);
  const [snapshot, setSnapshot] = useState<SavedCheckpoint | null>(null), [changes, setChanges] = useState<{ path: string; status: string }[]>([]), [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const endpoint = `/api/sessions/${run.sessionId}/runs/${run.id}/history`;
  const requestsInFlight = useRef(0);
  const generation = useRef(0);
  const openRef = useRef(false);
  const load = useCallback(async (suffix = "", options?: RequestInit) => {
    requestsInFlight.current++;
    try {
    const response = await fetch(endpoint + suffix, { cache: "no-store", ...options }); const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? "Could not load synchronized history."); return body;
    } finally { requestsInFlight.current--; }
  }, [endpoint]);
  const refresh = useCallback(async () => {
    const version = ++generation.current;
    try { const body = await load(); if (version === generation.current) { setData(body); setError(""); } }
    catch (cause) { if (version === generation.current) setError(cause instanceof Error ? cause.message : String(cause)); }
  }, [load]);
  useEffect(() => {
    openRef.current = open;
  }, [open]);
  useEffect(() => {
    const counter = generation;
    const poll = () => { if (!document.hidden && !requestsInFlight.current) void refresh(); };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const changed = () => { if (openRef.current && !timer) timer = setTimeout(() => { timer = undefined; poll(); }, 500); };
    const stream = openSessionStream(run.sessionId, { onRunActivity: event => { if (event.runId === run.id) changed(); }, onRunFinished: changed, onRunControl: changed, onStatus: connected => { if (connected) poll(); } });
    document.addEventListener("visibilitychange", poll);
    return () => { counter.current++; clearTimeout(timer); stream.close(); document.removeEventListener("visibilitychange", poll); };
  }, [refresh, run.sessionId, run.id]);
  async function showActivity(id: string, cursor = 0) {
    setBusy(true); setError("");
    try { const body = await load(`?turn=${id}&after=${cursor}`); const events = body.batches.flatMap((b: { events: AiRunEvent[] }) => b.events);
      setTurn(id); setAfter(body.next); setActivity(previous => cursor ? [...previous, ...events].slice(-1000) : events); }
    catch (cause) { setError(String(cause)); } finally { setBusy(false); }
  }
  async function showSnapshot(item: SavedCheckpoint) {
    setBusy(true); setError("");
    try { const body = await load(`?snapshot=${item.id}`); setSnapshot(item); setChanges(body.changes); setText(body.diff || "No file changes."); }
    catch (cause) { setError(String(cause)); } finally { setBusy(false); }
  }
  async function select() {
    if (!snapshot) return;
    setBusy(true); setError("");
    try { await load("", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ snapshotId: snapshot.id, version: run.controlVersion }) }); await refresh(); }
    catch (cause) { setError(String(cause)); } finally { setBusy(false); }
  }
  const synced = data?.turns.find(item => item.syncedAt)?.syncedAt;
  const syncLabel = synced ? `Activity synced ${new Date(synced).toLocaleTimeString()}` : "No activity synced yet";
  const checkpointSelected = !!data?.selectedSnapshotId;
  useEffect(() => {
    onStatus?.({ hint: `Activity & checkpoints · ${syncLabel}${checkpointSelected ? " · Checkpoint selected for next turn" : ""}`, checkpointSelected });
  }, [onStatus, syncLabel, checkpointSelected]);
  // Read on opening even if an older request is pending. The generation check
  // keeps that older response from replacing the fresh result.
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => void refresh(), 0);
    return () => clearTimeout(timer);
  }, [open, refresh]);
  return <>
    {open && <Modal title="Synchronized workspace history" description="Available even when the driver’s computer is offline. Only uploaded changes appear here." onClose={onClose}>
      <div className="max-h-[65vh] space-y-4 overflow-y-auto">
        <p role="status" className="text-xs text-vs-muted">{syncLabel}{data?.selectedSnapshotId ? " · Checkpoint selected for next turn" : ""}</p>
        <div className="space-y-2"><h3 className="font-semibold">Activity</h3>
          {!data?.turns.length && <p className="text-sm text-vs-muted">Activity will appear after your next local run.</p>}
          {data?.turns.map(item => <button key={item.id} className={`${button} mr-2 mb-2`} disabled={busy} onClick={() => void showActivity(item.id)}>{item.status} · {item.syncedAt ? new Date(item.syncedAt).toLocaleString() : "Not synced"}</button>)}
          {activity.length > 0 && <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-vs-editor p-3 text-xs">{activity.map(event => "d" in event ? event.d : event.t === "notice" ? event.message + "\n" : "").join("")}</pre>}
          {turn && <button className={button} disabled={busy} onClick={() => void showActivity(turn, after)}>Load next activity</button>}
        </div>
        <div className="space-y-2"><h3 className="font-semibold">Code checkpoints</h3>
          {!data?.snapshots.length && <p className="text-sm text-vs-muted">No uploaded checkpoints yet.</p>}
          <ComposerPicker label="Code checkpoint" variant="field" className="w-full" placeholder="Choose a checkpoint" value={snapshot?.id ?? ""} disabled={busy || !data?.snapshots.length} searchable searchLabel="Search checkpoints" onChange={value => { const item = data?.snapshots.find(s => s.id === value); if (item) void showSnapshot(item); }} options={data?.snapshots.map(item => ({ id: item.id, label: new Date(item.capturedAt).toLocaleString(), description: item.snapshotSha.slice(0,8) })) ?? []} />
          {snapshot && <><p className="text-xs text-vs-muted">Uploaded {new Date(snapshot.syncedAt).toLocaleString()}. Staged and unstaged changes are preserved separately.</p>
            <div className="flex flex-wrap gap-2">{changes.map(file => <button key={file.path} className={button} onClick={() => void load(`?snapshot=${snapshot.id}&path=${encodeURIComponent(file.path)}`).then(body => setText(body.binary ? "Binary file" : body.diff || body.text)).catch(cause => setError(cause.message))}>{file.status} {file.path}</button>)}</div>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-vs-editor p-3 text-xs">{text}</pre>
            {run.driverUserId === userId && !["running","queued"].includes(run.status) ? <button className={`${button} border-vs-accent text-vs-accent`} disabled={busy} onClick={() => void select()}>Use checkpoint for next turn</button> : <p className="text-xs text-vs-muted">Accept a handoff or recover the abandoned turn before restoring a checkpoint.</p>}
            <p className="text-xs text-vs-muted">Selecting does not start an agent. Your next prompt restores this checkpoint locally; existing local edits block restoration.</p></>}
        </div>
        {error && <p role="alert" className="text-sm text-vs-danger">{error}</p>}
      </div>
    </Modal>}
  </>;
}
