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
}: WelcomeViewProps) {
  return (
    <div className="vs-scroll flex min-h-0 flex-1 overflow-y-auto p-5 sm:p-8">
      <div
        className={`m-auto flex w-full max-w-2xl flex-col items-center gap-5 rounded-2xl border border-dashed px-6 py-10 text-center transition sm:px-10 ${
          dragging ? "border-vs-accent bg-vs-accent/10" : "border-vs-border"
        }`}
      >
        {seeding ? (
          <>
            <SpinnerIcon className="h-8 w-8 text-vs-accent" />
            <p className="text-base text-vs-fg">
              {seeding.phase === "finalizing" ? "Finishing import…" : "Uploading files…"}{" "}
              {seeding.phase === "finalizing" ? "Saving the room’s first version." : seeding.total > 0
                ? `${humanCount(seeding.uploaded)} of ${humanCount(seeding.total)} files`
                : `${humanCount(seeding.uploaded)} files`}
            </p>
            <p className="max-w-sm text-sm leading-5 text-vs-muted">
              Uploading your files and saving the room’s first version. Keep this page open until it finishes. You can browse the files as soon as they appear.
            </p>
          </>
        ) : scanning ? (
          <>
            <SpinnerIcon className="h-8 w-8 text-vs-accent" />
            <p className="text-base text-vs-fg">Reading folder… {humanCount(progress)} entries</p>
          </>
        ) : (
          <>
            <span className="rounded-2xl border border-vs-border bg-vs-panel p-4"><FolderUpIcon className="h-8 w-8 text-vs-accent" /></span>
            <div>
              <p className="mb-3 text-xs font-medium uppercase tracking-widest text-vs-muted">Your room is ready</p>
              <h1 className="font-display text-2xl font-semibold tracking-tight text-vs-fg sm:text-3xl">
                {readOnly ? "Waiting for the project’s files" : hasFolder ? "Select a file to start editing" : "Bring your code. Start something together."}
              </h1>
              <p className="mt-1.5 text-base leading-6 text-vs-muted">
                {readOnly ? "You have view-only access. Ask a room editor to add a folder; its files and chats will appear here." : hasRepo
                  ? "Choose a file in Files & changes. It opens beside your AI chat as another tab."
                  : "Choose a project folder, or drop one here. We’ll add its files to this room so you and your teammates can explore and work on them."}
              </p>
            </div>
            {!hasRepo && !readOnly && (
              <div className="flex flex-wrap items-center justify-center gap-2">
                <button
                  type="button"
                  onClick={onOpenPicker}
                  className="rounded bg-vs-accent px-4 py-2 text-base font-medium text-vs-accent-fg transition hover:opacity-90"
                >
                  Add a project folder
                </button>
              </div>
            )}
            {!hasRepo && !readOnly && <>
              <ol className="grid w-full gap-3 text-left text-sm sm:grid-cols-3">
                {[["Add files", "A plain folder works too. Git setup isn’t required."], ["Ask your AI", "Connect a provider and give it a small first task."], ["Review together", "Inspect Changes, then invite a teammate or hand off."]].map(([title, body], index) => <li key={title} className="rounded-xl border border-vs-border bg-vs-panel p-3"><span className="text-xs text-vs-muted">0{index + 1}</span><p className="mt-2 font-medium">{title}</p><p className="mt-1 text-xs leading-5 text-vs-muted">{body}</p></li>)}
              </ol>
              <p className="max-w-lg text-xs leading-5 text-vs-muted">Files are uploaded to this room and available to people with access. Check the folder for sensitive files before adding it.</p>
              {supportsPicker && <details className="text-sm text-vs-muted"><summary className="cursor-pointer rounded py-1">Having trouble choosing a folder?</summary><button type="button" onClick={onOpenInput} className="mt-2 rounded border border-vs-border px-3 py-2 text-vs-fg hover:bg-vs-hover">Use browser upload instead</button></details>}
            </>}
          </>
        )}

        {error && (
          <p role="alert" className="flex items-start gap-2 rounded border border-vs-danger/40 bg-vs-danger/10 px-3 py-2 text-left text-base text-vs-danger">
            <AlertIcon className="mt-0.5 h-4 w-4 shrink-0" />
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
