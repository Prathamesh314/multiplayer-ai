"use client";

import { useState } from "react";
import type { ProjectRepository } from "../../lib/project/repositories";
import type { RoomRepo } from "../../lib/session/roomRepos";
import { ErrorNote, GhostButton, Modal, PrimaryButton } from "../ui/Modal";

export function ProjectRepositoryPicker({ sessionId, selected, onAttached }: {
  sessionId: string; selected: string[]; onAttached: (repo: RoomRepo) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [repositories, setRepositories] = useState<ProjectRepository[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function show() {
    setOpen(true); setError(null); setRepositories(null);
    try {
      const response = await fetch(`/api/sessions/${sessionId}/project-repositories`, { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not load repositories.");
      setRepositories(body.repositories);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load repositories."); }
  }

  async function attach(id: string) {
    setBusy(id); setError(null);
    try {
      const response = await fetch(`/api/sessions/${sessionId}/repos`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectRepositoryId: id }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not open repository.");
      await onAttached(body.repo);
      setOpen(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not open repository."); }
    finally { setBusy(null); }
  }

  return <>
    <button type="button" onClick={() => void show()} className="rounded-lg border border-vs-border px-3 py-1.5 text-xs hover:bg-vs-hover">Project repositories</button>
    {open && <Modal title="Project repositories" description="Choose a repository for this room. Each repository has its own history and room checkout." onClose={() => { if (!busy) setOpen(false); }} footer={<GhostButton disabled={!!busy} onClick={() => setOpen(false)}>Close</GhostButton>}>
      {error && <ErrorNote>{error}</ErrorNote>}
      {!repositories && !error && <p role="status" className="text-sm text-vs-muted">Loading repositories…</p>}
      {repositories?.length === 0 && <p className="text-sm leading-6 text-vs-muted">No shared repositories yet. Import a folder into your room, then use Share repository to make its code available to the project.</p>}
      {repositories?.map(repository => <div key={repository.id} className="flex items-center gap-4 rounded-lg border border-vs-border p-3">
        <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{repository.name}</p><p className="text-xs text-vs-muted">{selected.includes(repository.id) ? "Already in this room" : "Shared with the project"}</p></div>
        <PrimaryButton disabled={!!busy || selected.includes(repository.id)} onClick={() => void attach(repository.id)}>{busy === repository.id ? "Opening…" : "Add to room"}</PrimaryButton>
      </div>)}
    </Modal>}
  </>;
}
