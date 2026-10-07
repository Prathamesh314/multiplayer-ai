"use client";
import { useState } from "react";
import type { AccessPreview } from "../../lib/collaboration/types";
import { sharingRequest } from "../../lib/sharing/client";
import { ErrorNote, GhostButton, PrimaryButton } from "../ui/Modal";

export function GuestAccess({runId, invitationId, onGranted, adminRequest = false}: {
  runId: string; invitationId: string; onGranted?: () => void; adminRequest?: boolean;
}) {
  const [preview, setPreview] = useState<AccessPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [confirmed, setConfirmed] = useState(false);
  const [outcome, setOutcome] = useState<'grant' | 'request' | 'decline' | null>(null);
  const endpoint = `/api/chats/${runId}/access`;
  async function load() {
    setBusy(true); setError(null); setConfirmed(false);
    try { setPreview(await sharingRequest<AccessPreview>(`${endpoint}?invitationId=${invitationId}`)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not check access.'); }
    finally { setBusy(false); }
  }
  async function submit(action: 'grant' | 'request' | 'decline') {
    if (busy || !preview || (action !== 'decline' && !confirmed)) return;
    setBusy(true); setError(null);
    try {
      await sharingRequest(endpoint, {method: 'POST', body: JSON.stringify({invitationId, action, confirm: confirmed, scopeKey: preview.scopeKey})});
      setOutcome(action); onGranted?.();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not update access.'); }
    finally { setBusy(false); }
  }
  const canRequest = preview?.canRequest && !preview.canGrant && !preview.requestPending;
  return <div className="w-full space-y-2">
    {outcome ? <p role="status" className="text-sm text-vs-success">
      {outcome === 'grant' ? 'Editing access granted. They can open the workspace from their shared chat. Use Handoff to offer control when you’re ready.'
        : outcome === 'request' ? 'Request sent to your organization’s admins. It appears in their collaboration inbox. The guest still has chat-only access.'
        : 'Request declined. The guest’s existing chat access is unchanged.'}
    </p> : !preview ? <GhostButton disabled={busy} onClick={() => void load()}>{busy ? 'Checking…' : adminRequest ? 'Review requested access…' : 'Allow guest to help with code…'}</GhostButton>
      : <div className="space-y-3 rounded-xl border border-vs-border bg-vs-editor p-3">
        <p className="font-medium">Editing access for {preview.email}</p>
        {preview.alreadyEditor ? <p className="text-sm text-vs-muted">This person already has editing access. Use Handoff to offer them control of the conversation.</p> : <>
          <ul className="list-disc space-y-1 pl-5 text-sm leading-6 text-vs-muted">{preview.scope.map(line => <li key={line}>{line}</li>)}</ul>
          {preview.reason && <p className="text-sm text-vs-warn">{preview.reason}</p>}
          {preview.requestPending && !preview.canGrant && <p role="status" className="text-sm text-vs-muted">Waiting for an organization admin. They can review this in their collaboration inbox.</p>}
          {(preview.canGrant || canRequest) && <>
            <label className="flex gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)}/>I approve the additional access described above.</label>
            <PrimaryButton disabled={busy || !confirmed} onClick={() => void submit(preview.canGrant ? 'grant' : 'request')}>
              {busy ? 'Saving…' : preview.canGrant ? 'Grant editing access' : 'Request admin approval'}
            </PrimaryButton>
          </>}
        </>}
        <div className="flex flex-wrap gap-2">
          {adminRequest && <GhostButton disabled={busy} onClick={() => void submit('decline')}>Decline request</GhostButton>}
          <GhostButton disabled={busy} onClick={() => void load()}>Refresh access</GhostButton>
          <GhostButton disabled={busy} onClick={() => {setPreview(null); setConfirmed(false);}}>Close access details</GhostButton>
        </div>
      </div>}
    {error && <ErrorNote>{error}</ErrorNote>}
  </div>;
}
