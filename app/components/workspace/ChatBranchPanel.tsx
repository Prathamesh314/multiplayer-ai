"use client";

import { useCallback, useEffect, useState } from "react";
import type { AgentRun } from "../../lib/ai/runs";
import { chatBranchAction, fetchChatBranch, fetchChatFileDiff, type ChatBranch } from "../../lib/ai/runs-client";
import { openSessionStream } from "../../lib/events/client";
import { ErrorNote, GhostButton, PrimaryButton } from "../ui/Modal";
import { DiffView } from "./DiffView";

/** What the agent is asked when a room update left conflict markers in its branch. */
export function resolveConflictsPrompt(files: string[]): string {
  return `The room's latest changes were merged into this chat's branch, and these files have conflict markers (<<<<<<<, =======, >>>>>>>):\n${files.map(file => `- ${file}`).join("\n")}\n\nResolve every conflict, keeping the intent of both sides, remove all markers, and check that the code still builds.`;
}

type Props = {
  sessionId: string;
  run: AgentRun;
  myUserId: string | null;
  /** Room edit access: merging needs it. */
  canEdit: boolean;
  isOwner: boolean;
  /** Put a prompt in the composer for the chat's driver to send. */
  onAskAgent: (prompt: string) => void;
};

type Conflict = { reason: "conflict" | "markers"; files: string[]; during: "merge" | "update" };

/**
 * Review and integrate a parallel chat: what it would bring into the room,
 * per-file diffs, and merge / update-from-room / discard. Every action is a
 * compare-and-swap on the heads shown here, so a stale view is refused rather
 * than merging something nobody reviewed.
 */
export function ChatBranchPanel({ sessionId, run, myUserId, canEdit, isOwner, onAskAgent }: Props) {
  const [branch, setBranch] = useState<ChatBranch | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  /** The loaded diff, with the path and head it belongs to, so a stale one is never shown. */
  const [diff, setDiff] = useState<{ key: string; text: string } | null>(null);

  const load = useCallback(() => fetchChatBranch(sessionId, run.id).then(
    next => { setBranch(next); setError(null); },
    cause => setError(cause instanceof Error ? cause.message : "Could not load this chat's changes."),
  ), [sessionId, run.id]);

  useEffect(() => {
    void load();
    const stream = openSessionStream(sessionId, {
      onRunBranch: event => { if (event.runId === run.id) void load(); },
      onRunFinished: event => { if (event.runId === run.id) void load(); },
      onFileSaved: () => void load(),
      onStatus: connected => { if (connected) void load(); },
    });
    return () => stream.close();
  }, [sessionId, run.id, load]);

  const diffKey = selected && branch ? `${branch.chatHead}:${selected}` : null;
  useEffect(() => {
    if (!selected || !diffKey) return;
    let cancelled = false;
    fetchChatFileDiff(sessionId, run.id, selected)
      .then(text => { if (!cancelled) setDiff({ key: diffKey, text }); })
      .catch(cause => { if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not load that file's changes."); });
    return () => { cancelled = true; };
  }, [sessionId, run.id, selected, diffKey]);

  // Live from the branch state, not the run object this view was opened with.
  const isDriver = !!myUserId && (branch?.driverUserId ?? run.driverUserId) === myUserId;
  const running = branch?.running ?? (run.status === "running" || run.status === "queued");
  const discarded = branch?.mergeState === "discarded";
  const markers = branch?.conflictMarkers ?? [];

  async function act(label: string, task: () => Promise<void>) {
    setBusy(label);
    setNotice(null);
    setError(null);
    try { await task(); } catch (cause) { setError(cause instanceof Error ? cause.message : "That didn’t work. Refresh and try again."); }
    finally { setBusy(null); await load(); }
  }

  const merge = () => act("merge", async () => {
    if (!branch) return;
    const outcome = await chatBranchAction(sessionId, run.id, { action: "merge", expectedChatHead: branch.chatHead, expectedRoomHead: branch.roomHead });
    if (!outcome.ok) { setConflict({ reason: outcome.reason, files: outcome.files, during: "merge" }); return; }
    setConflict(null);
    setNotice("Merged into the room. Publish shares it with the project.");
  });

  const update = (allowConflicts: boolean) => act(allowConflicts ? "resolve" : "update", async () => {
    if (!branch) return;
    const outcome = await chatBranchAction(sessionId, run.id, { action: "update", version: branch.controlVersion,
      expectedChatHead: branch.chatHead, expectedRoomHead: branch.roomHead, allowConflicts });
    if (!outcome.ok) { setConflict({ reason: "conflict", files: outcome.files, during: "update" }); return; }
    setConflict(null);
    const conflicts = "conflicts" in outcome ? outcome.conflicts : [];
    if (conflicts.length) onAskAgent(resolveConflictsPrompt(conflicts));
    else setNotice("This chat now includes the room's latest changes.");
  });

  const setDiscarded = (discard: boolean) => act(discard ? "discard" : "reopen", async () => {
    await chatBranchAction(sessionId, run.id, { action: discard ? "discard" : "reopen" });
    setNotice(discard ? "Discarded. The branch is kept; reopen the chat to continue." : "Reopened.");
  });

  if (!branch) {
    return error ? <ErrorNote>{error}</ErrorNote> : <p role="status" className="text-sm text-vs-muted">Loading this chat’s changes…</p>;
  }

  const added = branch.files.reduce((sum, file) => sum + file.added, 0);
  const removed = branch.files.reduce((sum, file) => sum + file.removed, 0);
  const state = discarded ? "Discarded" : branch.mergeState === "merged" && branch.ahead === 0 ? "Merged" : branch.ahead === 0 ? "No changes yet" : "Ready to review";

  return (
    <div className="space-y-4 text-sm">
      <section aria-label="Branch summary" className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="rounded-full border border-vs-border px-2 py-0.5 text-xs font-medium">{state}</span>
        <span className="text-xs text-vs-muted">
          {branch.ahead} commit{branch.ahead === 1 ? "" : "s"} ahead of the room · {branch.behind} behind
          {branch.files.length > 0 && <> · {branch.files.length} file{branch.files.length === 1 ? "" : "s"} <span className="text-vs-success">+{added}</span> <span className="text-vs-danger">−{removed}</span></>}
        </span>
      </section>

      {running && <p role="status" className="text-xs text-vs-muted">The chat is working. Merging and updating wait until its turn finishes.</p>}
      {notice && <p role="status" className="rounded-lg border border-vs-success/30 bg-vs-success/5 px-3 py-2 text-xs text-vs-success">{notice}</p>}
      {error && <ErrorNote>{error}</ErrorNote>}

      {markers.length > 0 && (
        <div role="alert" className="space-y-2 rounded-lg border border-vs-warn/40 bg-vs-warn/5 px-3 py-2.5 text-xs">
          <p>These files still have conflict markers. Resolve them before merging:</p>
          <ul className="list-disc pl-5 font-mono">{markers.map(file => <li key={file}>{file}</li>)}</ul>
          {isDriver && <GhostButton disabled={running} onClick={() => onAskAgent(resolveConflictsPrompt(markers))}>Ask the agent to resolve them</GhostButton>}
        </div>
      )}

      {conflict && conflict.reason === "conflict" && (
        <div role="alert" className="space-y-2 rounded-lg border border-vs-warn/40 bg-vs-warn/5 px-3 py-2.5 text-xs">
          <p>{conflict.during === "merge" ? "The room and this chat changed the same lines in:" : "Bringing in the room's changes conflicts in:"}</p>
          <ul className="list-disc pl-5 font-mono">{conflict.files.map(file => <li key={file}>{file}</li>)}</ul>
          {isDriver
            ? <>
                <p className="text-vs-muted">Bring the room&apos;s changes into this chat with conflict markers, and ask the agent to resolve them. The room is not changed.</p>
                <PrimaryButton disabled={!!busy || running} onClick={() => void update(true)}>{busy === "resolve" ? "Bringing in changes…" : "Bring in changes and ask the agent"}</PrimaryButton>
              </>
            : <p className="text-vs-muted">The chat&apos;s driver can bring in the room&apos;s changes and have the agent resolve them.</p>}
        </div>
      )}

      <section aria-label="Changed files" className="space-y-2">
        {branch.files.length === 0
          ? <p className="text-xs text-vs-muted">{branch.mergeState === "merged" ? "Everything in this chat is in the room." : "This chat hasn’t changed any files yet."}</p>
          : <ul className="divide-y divide-vs-border rounded-lg border border-vs-border">
              {branch.files.map(file => (
                <li key={file.path}>
                  <button type="button" aria-pressed={selected === file.path} onClick={() => setSelected(selected === file.path ? null : file.path)}
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-vs-hover ${selected === file.path ? "bg-vs-active" : ""}`}>
                    <span className="w-4 shrink-0 font-mono text-vs-muted" title={{ A: "Added", M: "Modified", D: "Deleted", R: "Renamed", C: "Copied" }[file.status]}>{file.status}</span>
                    <span className="min-w-0 flex-1 truncate font-mono">{file.path}</span>
                    {markers.includes(file.path) && <span className="shrink-0 text-[10px] text-vs-warn">conflicts</span>}
                    <span className="shrink-0 font-mono text-[10px] tabular-nums"><span className="text-vs-success">+{file.added}</span> <span className="text-vs-danger">−{file.removed}</span></span>
                  </button>
                </li>
              ))}
            </ul>}
        {selected && (diff?.key !== diffKey ? <p role="status" className="text-xs text-vs-muted">Loading {selected}…</p> : <DiffView diff={diff.text} label={`Changes to ${selected}`} />)}
      </section>

      <footer className="flex flex-wrap items-center gap-2 border-t border-vs-border pt-3">
        <PrimaryButton
          disabled={!canEdit || running || discarded || branch.ahead === 0 || markers.length > 0 || !!busy}
          title={!canEdit ? "Merging needs edit access to the room" : markers.length ? "Resolve the conflict markers first" : branch.ahead === 0 ? "Nothing to merge" : "Merge this chat's branch into the room branch"}
          onClick={() => void merge()}>
          {busy === "merge" ? "Merging…" : "Merge into room"}
        </PrimaryButton>
        <GhostButton
          disabled={!isDriver || running || discarded || branch.behind === 0 || !!busy}
          title={!isDriver ? "Only the chat's driver can update it" : branch.behind === 0 ? "This chat already has the room's latest changes" : "Bring the room's newer changes into this chat"}
          onClick={() => void update(false)}>
          {busy === "update" ? "Updating…" : "Update from room"}
        </GhostButton>
        {(isDriver || isOwner) && (discarded
          ? <GhostButton disabled={!!busy || running} onClick={() => void setDiscarded(false)}>{busy === "reopen" ? "Reopening…" : "Reopen"}</GhostButton>
          : branch.mergeState !== "merged" && <GhostButton disabled={!!busy || running} onClick={() => void setDiscarded(true)} className="ml-auto text-vs-muted">{busy === "discard" ? "Discarding…" : "Discard"}</GhostButton>)}
      </footer>
    </div>
  );
}
