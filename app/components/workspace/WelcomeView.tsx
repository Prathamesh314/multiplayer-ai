"use client";

import { humanCount } from "../../lib/format";
import { AlertIcon, FolderUpIcon, SpinnerIcon } from "../icons";

type WelcomeViewProps = {
  dragging: boolean;
  scanning: boolean;
  progress: number;
  supportsPicker: boolean;
  error: string | null;
  hasFolder: boolean;
  onOpenPicker: () => void;
  onOpenInput: () => void;
};

export function WelcomeView({
  dragging,
  scanning,
  progress,
  supportsPicker,
  error,
  hasFolder,
  onOpenPicker,
  onOpenInput,
}: WelcomeViewProps) {
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div
        className={`flex w-full max-w-lg flex-col items-center gap-4 rounded-xl border-2 border-dashed px-6 py-12 text-center transition ${
          dragging ? "border-vs-accent bg-vs-accent/10" : "border-vs-border"
        }`}
      >
        {scanning ? (
          <>
            <SpinnerIcon className="h-8 w-8 text-vs-accent" />
            <p className="text-sm text-vs-fg">Reading folder… {humanCount(progress)} entries</p>
          </>
        ) : (
          <>
            <FolderUpIcon className="h-10 w-10 text-vs-muted" />
            <div>
              <p className="text-base font-medium text-vs-fg">
                {hasFolder ? "Select a file to start editing" : "Drop a folder anywhere"}
              </p>
              <p className="mt-1 text-sm text-vs-muted">
                A Git repository or any plain folder — both work, and nothing leaves your browser.
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <button
                type="button"
                onClick={onOpenPicker}
                className="rounded bg-vs-accent px-4 py-2 text-sm font-medium text-vs-accent-fg transition hover:opacity-90"
              >
                {supportsPicker ? "Open folder…" : "Select folder…"}
              </button>
              {supportsPicker && (
                <button
                  type="button"
                  onClick={onOpenInput}
                  className="rounded border border-vs-border px-4 py-2 text-sm text-vs-fg transition hover:bg-vs-hover"
                >
                  Upload folder instead
                </button>
              )}
            </div>
            {!supportsPicker && (
              <p className="max-w-md text-xs text-vs-muted">
                This browser has no folder picker, so uploads are used instead. Some browsers hide
                dot-folders like <code className="font-mono">.git</code> from uploads, which can
                make Git detection fail.
              </p>
            )}
          </>
        )}

        {error && (
          <p className="flex items-start gap-2 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-left text-sm text-red-600 dark:text-red-300">
            <AlertIcon className="mt-0.5 h-4 w-4 shrink-0" />
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
