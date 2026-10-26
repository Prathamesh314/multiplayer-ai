"use client";

import { useEffect, useId, useState } from "react";
import type { LiveEdit } from "../../lib/types";
import { humanBytes } from "../../lib/format";
import { languageOf } from "../../lib/language";
import { fetchChangeDiff } from "../../lib/session/remote";
import type { ChangedFile } from "../../lib/session/types";
import { CloseIcon, SpinnerIcon } from "../icons";
import { ChangeCounts, LivePill, STATUS_META } from "./ChangesList";
import { DiffView } from "./DiffView";
import { FileTypeIcon } from "./FileTypeIcon";
import type { RoomChanges } from "./useRoomChanges";
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
  /** An agent is changing this file now; shown live and read-only until its turn ends. */
  live?: LiveEdit;
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
  pinned?: { label: string; icon: React.ReactNode; node: React.ReactNode };
  pinnedActive: boolean;
  onSelectPinned: () => void;
  /** The repository's changes: changed files get a Code / Changes switch and a diff view. */
  changes?: RoomChanges;
  diffSource?: { sessionId: string; repoId: string | null };
  /** Whether a tab shows its diff rather than its code. */
  showsDiff?: (path: string) => boolean;
  onShowDiff?: (path: string, diff: boolean) => void;
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
  pinned,
  pinnedActive,
  onSelectPinned,
  changes,
  diffSource,
  showsDiff = () => false,
  onShowDiff,
}: EditorAreaProps) {
  const tabId = useId();
  const active = activePath ? buffers.get(activePath) : undefined;
  const showPinned = !!pinned && pinnedActive;
  const showFile = !!activePath;
  const activeChange = activePath ? changes?.byPath.get(activePath) : undefined;
  // A deleted file has nothing to edit; one that is no longer changed has nothing to compare.
  const diffMode = !!activeChange && !!diffSource && (activeChange.status === "D" || showsDiff(activePath!));

  // Without a pinned tab and with no files open, the whole area is the empty state.
  if (!pinned && tabs.length === 0) {
    return <div className="flex min-h-0 flex-1 flex-col bg-vs-editor">{emptyState}</div>;
  }

  return (
    <div className="room-editor-layout flex min-h-0 min-w-0 flex-1 flex-col bg-vs-editor">
      <div role="tablist" aria-label="Workspace tabs" onKeyDown={event => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) || !(event.target instanceof HTMLElement) || event.target.getAttribute("role") !== "tab") return;
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
        const current = buttons.indexOf(event.target as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (current + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
        event.preventDefault();
        buttons[next]?.click();
        buttons[next]?.focus();
      }} className="vs-scroll flex min-h-8 shrink-0 overflow-x-auto border-b border-vs-border bg-vs-chrome">
        {pinned && (
          <div
            className={`flex shrink-0 items-center border-r border-vs-border ${
              showPinned
                ? "border-t-2 border-t-vs-accent bg-vs-editor text-vs-fg"
                : "border-t-2 border-t-transparent text-vs-muted hover:bg-vs-hover"
            }`}
          >
            <button
              type="button"
              onClick={onSelectPinned}
              role="tab"
              id={`${tabId}-chat`}
              aria-controls={`${tabId}-chat-panel`}
              aria-selected={showPinned}
              tabIndex={showPinned ? 0 : -1}
              className="flex items-center gap-1.5 px-2.5 py-1 text-[12px]"
            >
              {pinned.icon}
              <span>{pinned.label}</span>
            </button>
          </div>
        )}
        {tabs.map((path) => {
          const buffer = buffers.get(path);
          const dirty = !!buffer && !buffer.loading && buffer.text !== buffer.original;
          const isActive = !showPinned && path === activePath;

          return (
            <div
              key={path}
              className={`group flex shrink-0 items-center gap-2 border-r border-vs-border pl-2.5 pr-1.5 text-[12px] ${
                isActive
                  ? "border-t-2 border-t-vs-accent bg-vs-editor pt-0 text-vs-fg"
                  : "border-t-2 border-t-transparent text-vs-muted hover:bg-vs-hover"
              }`}
            >
              <button
                type="button"
                onClick={() => onSelectTab(path)}
                title={path}
                role="tab"
                id={`${tabId}-${path}`}
                aria-controls={`${tabId}-file-panel`}
                aria-selected={isActive}
                tabIndex={isActive ? 0 : -1}
                className="flex items-center gap-1.5 py-1"
              >
                <FileTypeIcon name={path} className="h-3.5 w-3.5" />
                <span className={`max-w-52 truncate ${changes?.byPath.get(path) ? STATUS_META[changes.byPath.get(path)!.status].name : ""}`}>{baseName(path)}</span>
                {showsDiff(path) && changes?.byPath.get(path) && <span className="text-[10.5px] text-vs-muted">Changes</span>}
                {dirty && <span className="text-xs text-vs-fg">●</span>}
                <EditingBadge people={editing.get(path) ?? []} />
              </button>
              <button
                type="button"
                onClick={() => onCloseTab(path)}
                aria-label={`Close ${baseName(path)}`}
                className="rounded p-0.5 text-vs-muted transition hover:bg-vs-hover hover:text-vs-fg"
              >
                <CloseIcon className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })}
      </div>

      {pinned && <div role="tabpanel" id={`${tabId}-chat-panel`} aria-labelledby={`${tabId}-chat`} className={`min-h-0 min-w-0 flex-1 flex-col ${showPinned ? "flex" : "hidden"}`}>{pinned.node}</div>}
      <div role="tabpanel" id={`${tabId}-file-panel`} aria-labelledby={activePath ? `${tabId}-${activePath}` : undefined} className={`room-file-document min-h-0 min-w-0 flex-1 flex-col ${showPinned ? "hidden" : "flex"}`}>
        {!showFile && (
          <div className="flex min-h-0 flex-1 flex-col">{emptyState}</div>
        )}

        {showFile && activePath && (
          <div className="flex shrink-0 items-center gap-3 border-b border-vs-border px-4 py-1 text-[12px] text-vs-muted">
            <div className="vs-scroll flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto whitespace-nowrap">
              {activePath.split("/").map((segment, index, all) => (
                <span key={index} className={index === all.length - 1 ? "text-vs-fg" : ""}>
                  {segment}
                  {index < all.length - 1 && <span className="px-1.5 opacity-60">›</span>}
                </span>
              ))}
            </div>
            {activeChange && diffSource && onShowDiff && (
              <div role="group" aria-label="Show" className="flex shrink-0 rounded-md border border-vs-border p-0.5">
                {activeChange.status !== "D" && (
                  <button type="button" aria-pressed={!diffMode} onClick={() => onShowDiff(activePath, false)}
                    className={`rounded px-2 py-0.5 text-[11px] font-medium ${!diffMode ? "bg-vs-active text-vs-fg" : "text-vs-muted hover:text-vs-fg"}`}>Code</button>
                )}
                <button type="button" aria-pressed={diffMode} onClick={() => onShowDiff(activePath, true)}
                  className={`flex items-center gap-1.5 rounded px-2 py-0.5 text-[11px] font-medium ${diffMode ? "bg-vs-active text-vs-fg" : "text-vs-muted hover:text-vs-fg"}`}>
                  Changes <ChangeCounts added={activeChange.added} removed={activeChange.removed} binary={activeChange.binary} compact />
                </button>
              </div>
            )}
          </div>
        )}

        {showFile && activePath && (editing.get(activePath)?.length ?? 0) > 0 && (
          <p className="flex shrink-0 items-center gap-2 border-b border-vs-border bg-vs-accent/5 px-4 py-1 text-[12px] text-vs-muted">
            <EditingBadge people={editing.get(activePath) ?? []} />
            <span>
              {(editing.get(activePath) ?? []).map((p) => p.name).join(", ")}
              {(editing.get(activePath) ?? []).length === 1 ? " is" : " are"} editing this file
            </span>
          </p>
        )}

        {showFile && diffMode && activeChange && diffSource && changes ? (
          <ChangeDiff key={activePath} source={diffSource} change={activeChange} changes={changes} />
        ) : showFile &&
          (!active || active.loading ? (
          <div className="flex flex-1 items-center justify-center gap-2 text-base text-vs-muted">
            <SpinnerIcon className="h-4 w-4" />
            Opening file…
          </div>
        ) : active.error ? (
          <Notice title="Could not open this file" detail={active.error} action={<button type="button" onClick={() => onReload(activePath)} className="mt-3 rounded-lg border border-vs-border px-3 py-2 text-sm hover:bg-vs-hover">Retry file</button>} />
        ) : active.binary ? (
          <Notice
            title="Binary file not shown"
            detail={`${humanBytes(active.size)} — the editor only renders text files.`}
          />
        ) : (
          <>
            {conflictAuthor && activePath && (
              <div className="flex flex-wrap items-center gap-2 border-b border-vs-border bg-vs-warn/10 px-3 py-1.5 text-sm text-vs-fg">
                <span>
                  {conflictAuthor} changed this file while you were editing it. Your version is
                  still here and was not overwritten.
                </span>
                <button
                  type="button"
                  onClick={() => onReload(activePath)}
                  className="rounded border border-vs-border px-2 py-0.5 text-[12px] transition hover:bg-vs-hover"
                >
                  Discard mine and reload
                </button>
              </div>
            )}

            {active.live && (
              <p role="status" className="flex items-center gap-2 border-b border-vs-border bg-vs-accent/10 px-3 py-1.5 text-sm text-vs-fg">
                <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-vs-accent motion-reduce:animate-none" aria-hidden />
                <span>
                  The AI is changing this file{active.live.title ? <> in “{active.live.title}”</> : null}. You’re seeing its latest
                  checkpoint; you can edit the file when that turn finishes.
                </span>
              </p>
            )}
            {active.truncated && (
              <p className="border-b border-vs-border bg-vs-warn/10 px-3 py-1.5 text-sm text-vs-fg">
                Showing the first 2 MB of a {humanBytes(active.size)} file.
              </p>
            )}
            <CodeEditor
              key={activePath}
              fileName={baseName(activePath!)}
              text={active.text}
              readOnly={readOnly || active.truncated || !!active.live}
              viewOnly={readOnly}
              remote={editing.get(activePath!) ?? []}
              onChange={(text) => onChange(activePath!, text)}
              onCaretChange={onCaretChange}
            />
          </>
        ))}
      </div>
    </div>
  );
}

/** One changed file's diff in the editor area, the way Conductor shows it beside the chat. */
function ChangeDiff({ source, change, changes }: { source: { sessionId: string; repoId: string | null }; change: ChangedFile; changes: RoomChanges }) {
  const head = changes.data?.head ?? "";
  const [diff, setDiff] = useState<{ head: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stale = diff?.head !== head;

  useEffect(() => {
    if (!stale || change.binary) return;
    const controller = new AbortController();
    fetchChangeDiff(source.sessionId, source.repoId, change.path, controller.signal)
      .then((text) => { setDiff({ head, text }); setError(null); })
      .catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not load this file's changes."); });
    return () => controller.abort();
  }, [stale, head, source.sessionId, source.repoId, change.path, change.binary]);

  const meta = STATUS_META[change.status];
  const viewed = changes.isViewed(change);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-vs-border bg-vs-chrome/60 px-4 py-1.5">
        <span className={`rounded px-1.5 py-px text-[11px] font-medium ${meta.className} ${meta.badge}`}>{meta.label}</span>
        <ChangeCounts added={change.added} removed={change.removed} binary={change.binary} bar />
        {changes.data?.live && <LivePill live={changes.data.live} />}
        <span className="text-[11px] text-vs-muted">since the repository was imported</span>
        <label className="ml-auto flex cursor-pointer items-center gap-1.5 rounded-md border border-vs-border px-2 py-0.5 text-[11px] text-vs-muted hover:text-vs-fg">
          <input type="checkbox" checked={viewed} onChange={() => changes.toggleViewed(change)} className="h-3 w-3 accent-vs-accent" />
          Viewed
        </label>
      </div>
      <div className="vs-scroll min-h-0 flex-1 overflow-auto">
        {change.binary ? (
          <Notice title="Binary file" detail={`${meta.label}. Git can’t show line changes for this kind of file.`} />
        ) : error ? (
          <p role="alert" className="px-4 py-3 text-sm text-vs-danger">{error}</p>
        ) : diff ? (
          <DiffView diff={diff.text} label={`Changes to ${change.path}`} path={change.path} bounded={false} />
        ) : (
          <p className="flex items-center gap-2 px-4 py-3 text-sm text-vs-muted"><SpinnerIcon className="h-3.5 w-3.5" /> Loading changes…</p>
        )}
      </div>
    </div>
  );
}

function Notice({ title, detail, action }: { title: string; detail: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-1 px-6 text-center">
      <p className="text-base text-vs-fg">{title}</p>
      <p className="text-sm text-vs-muted">{detail}</p>
      {action}
    </div>
  );
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function languageLabel(path: string | null): string {
  return path ? languageOf(baseName(path)).label : "";
}
