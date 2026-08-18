"use client";

import { humanBytes } from "../../lib/format";
import { languageOf } from "../../lib/language";
import { CloseIcon, FileIcon, SpinnerIcon } from "../icons";
import { EditingBadge } from "./People";
import type { FilePresence } from "./usePeople";
import type { Caret } from "./CodeEditor";
import { CodeEditor } from "./CodeEditor";

export type Buffer = {
  /** Contents as loaded from disk. */
  original: string;
  text: string;
  size: number;
  binary: boolean;
  truncated: boolean;
  loading: boolean;
  error?: string;
};

type EditorAreaProps = {
  tabs: string[];
  activePath: string | null;
  buffers: Map<string, Buffer>;
  onSelectTab: (path: string) => void;
  onCloseTab: (path: string) => void;
  onChange: (path: string, text: string) => void;
  onCaretChange: (caret: Caret) => void;
  emptyState: React.ReactNode;
  /** True when this account may open the session but not save to it. */
  readOnly: boolean;
  /** Who changed the active file while we had unsaved edits to it. */
  conflictAuthor?: string;
  onReload: (path: string) => void;
  /** Repo path → who is typing in it right now. */
  editing: Map<string, FilePresence[]>;
};

export function EditorArea({
  tabs,
  activePath,
  buffers,
  onSelectTab,
  onCloseTab,
  onChange,
  onCaretChange,
  emptyState,
  readOnly,
  conflictAuthor,
  onReload,
  editing,
}: EditorAreaProps) {
  const active = activePath ? buffers.get(activePath) : undefined;

  if (tabs.length === 0) {
    return <div className="flex min-h-0 flex-1 flex-col bg-vs-editor">{emptyState}</div>;
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-vs-editor">
      <div className="vs-scroll flex shrink-0 overflow-x-auto border-b border-vs-border bg-vs-chrome">
        {tabs.map((path) => {
          const buffer = buffers.get(path);
          const dirty = !!buffer && !buffer.loading && buffer.text !== buffer.original;
          const isActive = path === activePath;

          return (
            <div
              key={path}
              className={`group flex shrink-0 items-center gap-2 border-r border-vs-border pl-3 pr-2 text-[13px] ${
                isActive
                  ? "border-t-2 border-t-vs-accent bg-vs-editor pt-0 text-vs-fg"
                  : "border-t-2 border-t-transparent text-vs-muted hover:bg-vs-hover"
              }`}
            >
              <button
                type="button"
                onClick={() => onSelectTab(path)}
                title={path}
                className="flex items-center gap-2 py-1.5"
              >
                <FileIcon className="h-3.5 w-3.5" />
                <span className="max-w-52 truncate">{baseName(path)}</span>
                {dirty && <span className="text-xs text-vs-fg">●</span>}
                <EditingBadge people={editing.get(path) ?? []} />
              </button>
              <button
                type="button"
                onClick={() => onCloseTab(path)}
                aria-label={`Close ${baseName(path)}`}
                className="rounded p-0.5 text-vs-muted opacity-0 transition hover:bg-vs-hover hover:text-vs-fg group-hover:opacity-100"
              >
                <CloseIcon className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })}
      </div>

      {activePath && (
        <div className="flex shrink-0 items-center gap-1.5 border-b border-vs-border px-4 py-1 text-[11px] text-vs-muted">
          {activePath.split("/").map((segment, index, all) => (
            <span key={index} className={index === all.length - 1 ? "text-vs-fg" : ""}>
              {segment}
              {index < all.length - 1 && <span className="px-1.5 opacity-60">›</span>}
            </span>
          ))}
        </div>
      )}

      {activePath && (editing.get(activePath)?.length ?? 0) > 0 && (
        <p className="flex shrink-0 items-center gap-2 border-b border-vs-border bg-vs-accent/5 px-4 py-1 text-[11px] text-vs-muted">
          <EditingBadge people={editing.get(activePath) ?? []} />
          <span>
            {(editing.get(activePath) ?? []).map((p) => p.name).join(", ")}
            {(editing.get(activePath) ?? []).length === 1 ? " is" : " are"} editing this file
          </span>
        </p>
      )}

      {!active || active.loading ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-vs-muted">
          <SpinnerIcon className="h-4 w-4" />
          Opening file…
        </div>
      ) : active.error ? (
        <Notice title="Could not open this file" detail={active.error} />
      ) : active.binary ? (
        <Notice
          title="Binary file not shown"
          detail={`${humanBytes(active.size)} — the editor only renders text files.`}
        />
      ) : (
        <>
          {conflictAuthor && activePath && (
            <div className="flex flex-wrap items-center gap-2 border-b border-vs-border bg-amber-500/10 px-3 py-1.5 text-xs text-vs-fg">
              <span>
                {conflictAuthor} changed this file while you were editing it. Your version is
                still here and was not overwritten.
              </span>
              <button
                type="button"
                onClick={() => onReload(activePath)}
                className="rounded border border-vs-border px-2 py-0.5 text-[11px] transition hover:bg-vs-hover"
              >
                Discard mine and reload
              </button>
            </div>
          )}

          {active.truncated && (
            <p className="border-b border-vs-border bg-amber-500/10 px-3 py-1.5 text-xs text-vs-fg">
              Showing the first 2 MB of a {humanBytes(active.size)} file.
            </p>
          )}
          <CodeEditor
            key={activePath}
            fileName={baseName(activePath!)}
            text={active.text}
            readOnly={readOnly || active.truncated}
            remote={editing.get(activePath!) ?? []}
            onChange={(text) => onChange(activePath!, text)}
            onCaretChange={onCaretChange}
          />
        </>
      )}
    </div>
  );
}

function Notice({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-1 px-6 text-center">
      <p className="text-sm text-vs-fg">{title}</p>
      <p className="text-xs text-vs-muted">{detail}</p>
    </div>
  );
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function languageLabel(path: string | null): string {
  return path ? languageOf(baseName(path)).label : "";
}
