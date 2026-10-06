"use client";

import { useRef, useState } from "react";
import { createEmptyRoomRepo, type RoomRepo } from "../../lib/session/remote";
import { FolderUpIcon, SparkleIcon, SpinnerIcon } from "../icons";
import { ErrorNote, Field, GhostButton, inputClass, Modal, PrimaryButton } from "../ui/Modal";
import { ProjectRepositoryPicker } from "./ProjectRepositoryPicker";

export function AddProjectDialog({ sessionId, sharedProject, selected, startEmpty = false, onClose, onImport, onAdded }: {
  sessionId: string;
  sharedProject: boolean;
  selected: string[];
  startEmpty?: boolean;
  onClose: () => void;
  onImport: () => void;
  onAdded: (repo: RoomRepo, empty: boolean) => Promise<void>;
}) {
  const [empty, setEmpty] = useState(startEmpty);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  // If switching fails (e.g. an unsaved edit), retry opening the project that
  // was already created instead of allocating another one.
  const [created, setCreated] = useState<RoomRepo | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    if (pending.current || !name.trim()) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const repo = created ?? await createEmptyRoomRepo(sessionId, name);
      setCreated(repo);
      await onAdded(repo, true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create the project. Please try again.");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  return <Modal title={empty ? "Start empty project" : "Add Project"}
    description={empty ? "Give your project a name, then start a conversation. No folder, repository, or files needed." : "Start with a conversation, import a folder, or choose a shared repository."}
    onClose={() => { if (!pending.current) onClose(); }}
    footer={empty ? <><GhostButton disabled={busy} onClick={onClose}>Cancel</GhostButton><PrimaryButton disabled={busy || !name.trim()} onClick={() => void create()}>{busy && <SpinnerIcon className="h-4 w-4" />}{busy ? "Creating…" : created ? "Open project" : "Create project"}</PrimaryButton></> : undefined}>
    {error && <ErrorNote>{error}</ErrorNote>}
    {empty ? <Field label="Project name" hint="Use it for questions, brainstorming, writing, or building something from scratch.">
      <input autoFocus className={inputClass} value={name} maxLength={100} disabled={busy || !!created} onChange={event => setName(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); void create(); } }} placeholder="Ideas and questions" />
    </Field> : <>
      <div className="space-y-2.5">
        <button type="button" aria-label="Start empty project" onClick={() => setEmpty(true)} className="flex w-full items-start gap-2.5 rounded-xl border border-vs-border bg-vs-editor p-3 text-left transition hover:border-vs-accent hover:bg-vs-hover focus-visible:outline-2 focus-visible:outline-vs-accent">
          <SparkleIcon className="mt-0.5 h-4 w-4 shrink-0 text-vs-accent" /><span><span className="block text-sm font-medium">Start empty project</span><span className="mt-0.5 block text-xs leading-5 text-vs-muted">Just chat with AI. No folder or repository needed.</span></span>
        </button>
        <button type="button" aria-label="Import folder" onClick={onImport} className="flex w-full items-start gap-2.5 rounded-xl border border-vs-border bg-vs-editor p-3 text-left transition hover:border-vs-accent hover:bg-vs-hover focus-visible:outline-2 focus-visible:outline-vs-accent">
          <FolderUpIcon className="mt-0.5 h-4 w-4 shrink-0 text-vs-muted" /><span><span className="block text-sm font-medium">Import folder</span><span className="mt-0.5 block text-xs leading-5 text-vs-muted">Work with files already on your computer.</span></span>
        </button>
      </div>
      {sharedProject && <ProjectRepositoryPicker sessionId={sessionId} selected={selected} onAttached={repo => onAdded(repo, false)} />}
    </>}
  </Modal>;
}
