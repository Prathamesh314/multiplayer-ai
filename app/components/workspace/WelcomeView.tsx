"use client";

import { humanCount } from "../../lib/format";
import type { SeedProgress } from "../../lib/session/remote";
import { AlertIcon, FolderUpIcon, SpinnerIcon } from "../icons";

type WelcomeViewProps = {
  readOnly?: boolean;
  dragging: boolean;
  scanning: boolean;
  progress: number;
  supportsPicker: boolean;
  error: string | null;
  hasFolder: boolean;
  /**
   * True once a repo is committed to the session. Seeding can only happen once,
   * so the folder-open actions are hidden and this becomes a "pick a file" prompt.
   */
  hasRepo: boolean;
  /** Set while the folder is being uploaded into the session repository. */
  seeding: SeedProgress | null;
  onOpenPicker: () => void;
  onOpenInput: () => void;
  onStartEmpty: () => void;
};

export function WelcomeView({
  readOnly = false,
  dragging,
  scanning,
  progress,
  supportsPicker,
  error,
  hasFolder,
  hasRepo,
  seeding,
  onOpenPicker,
  onOpenInput,
  onStartEmpty,
}: WelcomeViewProps) {
  return (
    <div className="vs-scroll flex min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
      <div
        className={`m-auto flex w-full max-w-2xl flex-col items-center gap-4 rounded-2xl border border-dashed px-5 py-8 text-center transition sm:px-8 ${
          dragging ? "border-vs-accent bg-vs-accent/10" : "border-vs-border"
        }`}
      >
        {seeding ? (
          <>
            <SpinnerIcon className="h-6 w-6 text-vs-accent" />
            <p className="text-sm text-vs-fg">
              {seeding.phase === "finalizing" ? "Finishing import…" : "Uploading files…"}{" "}
              {seeding.phase === "finalizing" ? "Saving the room’s first version." : seeding.total > 0
                ? `${humanCount(seeding.uploaded)} of ${humanCount(seeding.total)} files`
                : `${humanCount(seeding.uploaded)} files`}
            </p>
            <p className="max-w-sm text-xs leading-5 text-vs-muted">
              Uploading your files and saving the room’s first version. Keep this page open until it finishes. You can browse the files as soon as they appear.
            </p>
          </>
        ) : scanning ? (
          <>
            <SpinnerIcon className="h-6 w-6 text-vs-accent" />
            <p className="text-sm text-vs-fg">Reading folder… {humanCount(progress)} entries</p>
          </>
        ) : (
          <>
            <span className="rounded-xl border border-vs-border bg-vs-panel p-3"><FolderUpIcon className="h-6 w-6 text-vs-accent" /></span>
            <div>
              <p className="mb-2 text-[13px] font-medium uppercase tracking-widest text-vs-muted">Your room is ready</p>
              <h1 className="font-display text-xl font-semibold tracking-tight text-vs-fg sm:text-2xl">
                {readOnly ? "Waiting for a project" : hasFolder ? "Select a file to start editing" : "Start a conversation or bring your code"}
              </h1>
              <p className="mt-1.5 text-sm leading-5 text-vs-muted">
                {readOnly ? "You have view-only access. Ask a room editor to start an empty project or import a folder; its chats and files will appear here." : hasRepo
                  ? "Choose a file in Files & changes. It opens beside your AI chat as another tab."
                  : "Ask questions, brainstorm, or write with AI in an empty project. You can also import a folder if you want to work with existing code."}
              </p>
            </div>
            {!hasRepo && !readOnly && (
              <div className="flex flex-wrap items-center justify-center gap-2">
                <button type="button" onClick={onStartEmpty} className="rounded-lg bg-vs-accent px-3 py-1.5 text-sm font-medium text-vs-accent-fg transition hover:opacity-90">Start empty project</button>
                <button
                  type="button"
                  onClick={onOpenPicker}
                  className="rounded-lg border border-vs-border px-3 py-1.5 text-sm font-medium transition hover:bg-vs-hover"
                >
                  Add a project folder
                </button>
              </div>
            )}
            {!hasRepo && !readOnly && <>
              <ol className="grid w-full gap-2.5 text-left text-xs sm:grid-cols-3">
                {[["Choose a starting point", "Start empty or import a folder. Files are optional."], ["Set up AI", "Connect your computer and choose your AI in the message box."], ["Start chatting", "Ask anything, explore an idea, or build something together."]].map(([title, body], index) => <li key={title} className="rounded-xl border border-vs-border bg-vs-panel p-2.5"><span className="text-[13px] text-vs-muted">0{index + 1}</span><p className="mt-1.5 font-medium">{title}</p><p className="mt-1 text-[13px] leading-4 text-vs-muted">{body}</p></li>)}
              </ol>
              <p className="max-w-lg text-[13px] leading-4 text-vs-muted">Files are uploaded to this room and available to people with access. Check the folder for sensitive files before adding it.</p>
              {supportsPicker && <details className="text-xs text-vs-muted"><summary className="cursor-pointer rounded py-1">Having trouble choosing a folder?</summary><button type="button" onClick={onOpenInput} className="mt-2 rounded border border-vs-border px-2.5 py-1.5 text-vs-fg hover:bg-vs-hover">Use browser upload instead</button></details>}
            </>}
          </>
        )}

        {error && (
          <p role="alert" className="flex items-start gap-2 rounded border border-vs-danger/40 bg-vs-danger/10 px-2.5 py-1.5 text-left text-sm text-vs-danger">
            <AlertIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
