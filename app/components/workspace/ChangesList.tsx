"use client";

import { relativeTime } from "../../lib/format";
import type { ChangedFile, ChangesResponse } from "../../lib/session/types";
import { CheckIcon, SpinnerIcon } from "../icons";

export const STATUS_META: Record<ChangedFile["status"], { label: string; className: string; badge: string }> = {
  A: { label: "Added", className: "text-vs-success", badge: "bg-vs-success/10" },
  M: { label: "Modified", className: "text-vs-warn", badge: "bg-vs-warn/10" },
  D: { label: "Deleted", className: "text-vs-danger", badge: "bg-vs-danger/10" },
  R: { label: "Renamed", className: "text-vs-accent", badge: "bg-vs-accent/10" },
  C: { label: "Copied", className: "text-vs-accent", badge: "bg-vs-accent/10" },
};

export function splitPath(path: string): { dir: string; name: string } {
  const at = path.lastIndexOf("/");
  return at < 0 ? { dir: "", name: path } : { dir: path.slice(0, at), name: path.slice(at + 1) };
}

/** "+12 −3", optionally with GitHub's five-block bar of the added/removed share. */
export function ChangeCounts({ added = 0, removed = 0, compact = false, bar = false }: { added?: number; removed?: number; compact?: boolean; bar?: boolean }) {
  const total = added + removed;
  const green = total ? Math.round((added / total) * 5) : 0;
  return (
    <span className={`flex shrink-0 items-center gap-1.5 font-mono tabular-nums ${compact ? "text-[10.5px]" : "text-[11px]"}`} aria-label={`${added} lines added, ${removed} lines removed`}>
      {(added > 0 || !compact) && <span className="text-vs-success">+{added}</span>}
      {(removed > 0 || !compact) && <span className="text-vs-danger">−{removed}</span>}
      {bar && total > 0 && (
        <span aria-hidden className="flex gap-px">
          {Array.from({ length: 5 }, (_, index) => (
            <span key={index} className={`h-2 w-2 rounded-[2px] ${index < green ? "bg-vs-success" : index < (removed ? 5 : green) ? "bg-vs-danger" : "bg-vs-border"}`} />
          ))}
        </span>
      )}
    </span>
  );
}

/** An agent is working: these changes include its worktree as of its last checkpoint. */
export function LivePill({ live }: { live: NonNullable<ChangesResponse["live"]> }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5 rounded-full border border-vs-accent/30 bg-vs-accent/10 px-2 py-0.5 text-[11px] text-vs-accent" title={`Includes the agent's work in progress, saved ${relativeTime(live.capturedAt / 1000)}`}>
      <span className="relative flex h-1.5 w-1.5 shrink-0">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-60" />
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-current" />
      </span>
      <span className="truncate">Agent editing{live.title ? ` · ${live.title}` : ""}</span>
    </span>
  );
}

/**
 * The explorer's Changes tab: what this room changed since import, with line
 * counts per file. Choosing a file opens it in the review; "Open" goes to the
 * editor.
 */
export function ChangesList({
  data,
  loading,
  activePath,
  viewed,
  onReview,
  onOpenFile,
}: {
  data: ChangesResponse | null;
  loading: boolean;
  activePath: string | null;
  viewed: (file: ChangedFile) => boolean;
  onReview: (path: string | null) => void;
  onOpenFile: (path: string) => void;
}) {
  if (loading && data === null) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-sm text-vs-muted">
        <SpinnerIcon className="h-3.5 w-3.5" />
        Reading changes…
      </div>
    );
  }

  const changes = data?.changes ?? [];
  if (changes.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-xs text-vs-muted">
        {data?.live && <LivePill live={data.live} />}
        {data?.live ? "The agent hasn't changed any files yet." : "No changes since the session started."}
      </div>
    );
  }

  const totals = data?.totals;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 space-y-1.5 border-b border-vs-border px-3 py-2">
        <div className="flex items-center gap-2">
          <p className="min-w-0 flex-1 text-xs">
            <span className="font-medium text-vs-fg">{changes.length} {changes.length === 1 ? "file" : "files"} changed</span>
          </p>
          {totals && <ChangeCounts added={totals.added} removed={totals.removed} />}
          <button type="button" onClick={() => onReview(null)} className="rounded-md bg-vs-accent px-2 py-0.5 text-[11px] font-medium text-vs-accent-fg hover:opacity-90">
            Review
          </button>
        </div>
        {data?.live && <LivePill live={data.live} />}
      </div>
      <ul className="vs-scroll min-h-0 flex-1 overflow-auto py-1" aria-label="Changed files">
        {changes.map((change) => {
          const meta = STATUS_META[change.status];
          const deleted = change.status === "D";
          const { dir, name } = splitPath(change.path);
          const seen = viewed(change);
          return (
            <li key={change.path} className={`group flex items-center ${change.path === activePath ? "bg-vs-active" : "hover:bg-vs-hover"}`}>
              <button
                type="button"
                onClick={() => onReview(change.path)}
                title={`${meta.label}: ${change.path}`}
                className={`flex min-w-0 flex-1 items-center gap-2 py-1 pl-3 pr-1 text-left text-[12px] ${seen ? "opacity-60" : ""}`}
              >
                <span className={`w-3 shrink-0 text-center font-mono text-[11px] font-semibold ${meta.className}`} aria-label={meta.label}>{change.status}</span>
                <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                  <span className={`shrink-0 truncate ${deleted ? "text-vs-muted line-through" : "font-medium text-vs-fg"}`}>{name}</span>
                  {/* Truncate the folder from its start, so the part nearest the file stays visible. */}
                  {dir && <span className="min-w-0 truncate text-[11px] text-vs-muted" dir="rtl"><bdi dir="ltr">{dir}</bdi></span>}
                </span>
                {seen ? <CheckIcon className="h-3.5 w-3.5 shrink-0 text-vs-success" aria-label="Viewed" /> : <ChangeCounts added={change.added} removed={change.removed} compact />}
              </button>
              {!deleted && (
                <button type="button" onClick={() => onOpenFile(change.path)} aria-label={`Open ${change.path} in the editor`} className="mr-1.5 shrink-0 rounded px-1.5 py-0.5 text-[10.5px] text-vs-muted opacity-0 hover:bg-vs-hover hover:text-vs-fg focus:opacity-100 group-hover:opacity-100">
                  Open
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
