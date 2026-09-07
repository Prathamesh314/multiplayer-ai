"use client";

import { useRef, useState, useSyncExternalStore } from "react";
import {
  describeSource,
  pickDirectory,
  sourceFromDrop,
  sourceFromFileList,
  supportsDirectoryPicker,
  type PickedSource,
} from "../../lib/folder";
import { createSession } from "../../lib/session/client";
import { stashFolder } from "../../lib/session/handoff";
import { CheckIcon, FolderIcon, FolderUpIcon, SpinnerIcon } from "../icons";
import { ErrorNote, Field, GhostButton, inputClass, Modal, PrimaryButton } from "../ui/Modal";

const noopSubscribe = () => () => {};
const yes = () => supportsDirectoryPicker();
const no = () => false;

export function CreateSessionDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (sessionId: string) => void;
}) {
  const supportsPicker = useSyncExternalStore(noopSubscribe, yes, no);
  const inputRef = useRef<HTMLInputElement>(null);

  const [name, setName] = useState("");
  const [source, setSource] = useState<PickedSource | null>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function browse() {
    setError(null);
    if (!supportsPicker) {
      inputRef.current?.click();
      return;
    }
    try {
      const picked = await pickDirectory();
      if (picked) setSource(picked);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not open that folder.");
    }
  }

  async function onDrop(event: React.DragEvent) {
    event.preventDefault();
    setDragging(false);
    setError(null);
    try {
      const picked = await sourceFromDrop(event.dataTransfer);
      if (picked) setSource(picked);
      else setError("Drop a folder, not a single file.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not read that folder.");
    }
  }

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const session = await createSession(name.trim() || undefined);
      // The folder is handed to the session that is about to open.
      if (source) stashFolder(session.id, source);
      onCreated(session.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create a session.");
      setBusy(false);
    }
  }

  const chosen = source ? describeSource(source) : null;

  return (
    <Modal
      title="New session"
      description="Name it, and optionally open the project folder now. You can also pick the folder once you are inside."
      onClose={onClose}
      footer={
        <>
          <GhostButton onClick={onClose} disabled={busy}>
            Cancel
          </GhostButton>
          <PrimaryButton onClick={create} disabled={busy}>
            {busy && <SpinnerIcon className="h-4 w-4" />}
            {busy ? "Creating…" : "Create session"}
          </PrimaryButton>
        </>
      }
    >
      <Field label="Session name" hint="Optional — one is generated if you leave it blank.">
        <input
          autoFocus
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !busy) void create();
          }}
          placeholder="Checkout refactor"
          maxLength={60}
          className={inputClass}
        />
      </Field>

      <div>
        <span className="text-[12px] font-semibold uppercase tracking-wider text-vs-muted">
          Project folder
        </span>

        <input
          ref={inputRef}
          type="file"
          multiple
          webkitdirectory=""
          directory=""
          onChange={(event) => {
            setSource(sourceFromFileList(event.target.files));
            event.target.value = "";
          }}
          className="hidden"
        />

        {chosen ? (
          <div className="mt-1.5 flex items-center gap-3 rounded-lg border border-vs-border bg-vs-editor px-3 py-2.5">
            <FolderIcon open className="h-4 w-4 text-sky-500 dark:text-sky-400" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-base">{chosen.name}</span>
              <span className="block text-[12px] text-vs-muted">{chosen.detail}</span>
            </span>
            <CheckIcon className="h-4 w-4 text-vs-success" />
            <button
              type="button"
              onClick={() => setSource(null)}
              className="rounded px-2 py-1 text-[12px] text-vs-muted transition hover:bg-vs-hover hover:text-vs-fg"
            >
              Change
            </button>
          </div>
        ) : (
          <div
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={`mt-1.5 flex flex-col items-center gap-2.5 rounded-lg border border-dashed px-4 py-6 text-center transition ${
              dragging ? "border-vs-accent bg-vs-accent/10" : "border-vs-border"
            }`}
          >
            <FolderUpIcon className="h-7 w-7 text-vs-muted" />
            <p className="text-sm text-vs-muted">
              Drop a folder here — a Git repo or any plain folder.
            </p>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <GhostButton onClick={browse}>
                {supportsPicker ? "Open folder…" : "Select folder…"}
              </GhostButton>
              {supportsPicker && (
                <button
                  type="button"
                  onClick={() => inputRef.current?.click()}
                  className="rounded-lg px-3 py-2 text-sm text-vs-muted transition hover:bg-vs-hover hover:text-vs-fg"
                >
                  Upload instead
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      <p className="text-[12px] leading-5 text-vs-muted">
        Folders are read in your browser — nothing is uploaded to a server.
      </p>

      {error && <ErrorNote>{error}</ErrorNote>}
    </Modal>
  );
}
