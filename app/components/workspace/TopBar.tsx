"use client";

import { useState } from "react";
import { publishRoom, syncRoom } from "../../lib/session/client";
import { canEdit, type Session, type SessionMember } from "../../lib/session/types";
import { ArrowIcon, GitBranchIcon, SparkleIcon, TerminalIcon, UserPlusIcon } from "../icons";
import { PeopleStack } from "./People";

type TopBarProps = {
  onOpenGuide: () => void;
  session: Session;
  onInvite: () => void;
  inviteLabel?: string;
  onLeave: () => void;
  onNavigate: (direction: "back" | "forward") => void;
  navigationPending: boolean;
  folderName: string | null;
  branch: string | null;
  isGit: boolean;
  terminalOpen: boolean;
  onToggleTerminal: () => void;
  onOpenFolder: () => void;
  /** False once this session owns a repo — a session is seeded exactly once. */
  canOpenFolder: boolean;
  members: SessionMember[];
  repoId: string | null;
  hasRepository: boolean;
  sharedRepository: boolean;
  beforePublish: () => Promise<boolean>;
  onPublished: () => Promise<void>;
};

export function TopBar({
  onOpenGuide,
  session,
  onInvite,
  inviteLabel = "Invite",
  onLeave,
  onNavigate,
  navigationPending,
  folderName,
  branch,
  isGit,
  terminalOpen,
  onToggleTerminal,
  onOpenFolder,
  canOpenFolder,
  members,
  repoId, hasRepository, sharedRepository, beforePublish, onPublished,
}: TopBarProps) {
  return (
    <header className="room-toolbar flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-vs-border bg-vs-chrome px-3 py-2">
      <div className="flex min-w-0 flex-1 items-center gap-2">
      <nav aria-label="Page history" className="flex shrink-0 items-center gap-0.5">
        {(["back", "forward"] as const).map(direction => (
          <button
            key={direction}
            type="button"
            aria-label={direction === "back" ? "Go back" : "Go forward"}
            title={direction === "back" ? "Go back" : "Go forward"}
            onClick={() => onNavigate(direction)}
            disabled={navigationPending}
            className="flex h-7 w-7 items-center justify-center rounded-md text-vs-muted transition hover:bg-vs-hover hover:text-vs-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-vs-accent disabled:pointer-events-none disabled:opacity-40"
          >
            <ArrowIcon direction={direction === "back" ? "left" : "right"} className="h-4 w-4" />
          </button>
        ))}
      </nav>
      <button
        type="button"
        onClick={onLeave}
        disabled={navigationPending}
        title="Back to projects"
        className="flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-1.5 text-xs font-semibold text-vs-fg transition hover:bg-vs-hover"
      >
        <SparkleIcon className="h-3.5 w-3.5 text-vs-accent" />
        <span className="whitespace-nowrap">
          multiplayer<span className="text-vs-muted">-ai</span>
        </span>
      </button>

      <span aria-hidden="true" className="text-vs-muted/50">/</span>
      <span
        title={`Session ${session.id}`}
        className="min-w-0 max-w-56 truncate text-xs font-medium text-vs-fg"
      >
        {session.name}
      </span>

      </div>
      <div className="room-toolbar-actions vs-scroll ml-auto flex max-w-full items-center gap-1.5">
      {canOpenFolder && (
        <button
          type="button"
          onClick={onOpenFolder}
          className="shrink-0 rounded px-1.5 py-0.5 text-xs text-vs-muted transition hover:bg-vs-hover hover:text-vs-fg"
        >
          Open folder…
        </button>
      )}

      <div className="hidden min-w-0 max-w-48 items-center gap-1.5 rounded-lg bg-vs-panel px-2 py-1 text-[11px] text-vs-muted xl:flex">
        <span className="truncate">
          {folderName ?? "No folder open"}
          {folderName && isGit && branch && (
            <span className="ml-2 inline-flex items-center gap-1 font-mono text-vs-fg">
              <GitBranchIcon className="inline h-3 w-3" />
              {branch}
            </span>
          )}
        </span>
      </div>

      {session.projectId && hasRepository && canEdit(session.myRole) && (
        <PublishControls key={repoId ?? "legacy"} sessionId={session.id} repoId={repoId} shared={sharedRepository} beforePublish={beforePublish} onPublished={onPublished} />
      )}

      <div className="hidden px-1 sm:block"><PeopleStack members={members} /></div>

      <button type="button" onClick={onOpenGuide} className="shrink-0 rounded-lg border border-vs-border px-2 py-1 text-xs hover:bg-vs-hover">Room guide</button>

      <button
        type="button"
        onClick={onInvite}
        className="flex shrink-0 items-center gap-1 rounded bg-vs-accent px-2 py-1 text-xs font-medium text-vs-accent-fg transition hover:opacity-90"
      >
        <UserPlusIcon className="h-3 w-3" />
        {inviteLabel}
      </button>

      <div className="flex items-center gap-0.5">
        <ToggleButton
          label="Toggle terminal (Ctrl+Shift+Z)"
          active={terminalOpen}
          onClick={onToggleTerminal}
        >
          <TerminalIcon className="h-3.5 w-3.5" />
        </ToggleButton>
      </div>
      </div>
    </header>
  );
}

/**
 * Sync and publish the selected repository's room branch.
 */
function PublishControls({ sessionId, repoId, shared, beforePublish, onPublished }: { sessionId: string; repoId: string | null; shared: boolean; beforePublish: () => Promise<boolean>; onPublished: () => Promise<void> }) {
  const [busy, setBusy] = useState<"publish" | "sync" | null>(null);
  const [status, setStatus] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  async function run(kind: "publish" | "sync") {
    setBusy(kind);
    setStatus(null);
    try {
      if (!await beforePublish()) throw new Error("Save or resolve your edits first.");
      const outcome = await (kind === "publish" ? publishRoom(sessionId, repoId) : syncRoom(sessionId, repoId));
      if (outcome.ok) {
        await onPublished();
        setStatus({ tone: "ok", text: kind === "publish" ? "Published to project" : "Up to date with project" });
      } else {
        setStatus({
          tone: "error",
          text: `Conflict in ${outcome.files.slice(0, 2).join(", ")}${outcome.files.length > 2 ? "…" : ""} — resolve it in the room first`,
        });
      }
    } catch (cause) {
      setStatus({ tone: "error", text: cause instanceof Error ? cause.message : "Something went wrong." });
    } finally {
      setBusy(null);
      setTimeout(() => setStatus(null), 6000);
    }
  }

  return (
    <div className="flex shrink-0 items-center gap-1">
      <button
        type="button"
        onClick={() => run("sync")}
        disabled={busy !== null || !shared}
        title="Get the selected repository’s latest shared changes"
        className="rounded px-1.5 py-0.5 text-xs text-vs-muted transition hover:bg-vs-hover hover:text-vs-fg disabled:opacity-50"
      >
        {busy === "sync" ? "Syncing…" : "Get latest"}
      </button>
      <button
        type="button"
        onClick={() => run("publish")}
        disabled={busy !== null}
        title="Share saved changes in the selected repository with project members. Review Changes first."
        className="flex items-center gap-1 rounded border border-vs-border px-1.5 py-0.5 text-xs text-vs-fg transition hover:bg-vs-hover disabled:opacity-50"
      >
        <GitBranchIcon className="h-3 w-3" />
        {busy === "publish" ? "Publishing…" : shared ? "Publish" : "Share repository"}
      </button>
      {status && (
        <span
          className={`max-w-64 truncate text-[10px] ${status.tone === "ok" ? "text-vs-success" : "text-vs-danger"}`}
          title={status.text}
        >
          {status.text}
        </span>
      )}
    </div>
  );
}

function ToggleButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={`rounded p-1 transition hover:bg-vs-hover ${active ? "text-vs-fg" : "text-vs-muted"}`}
    >
      {children}
    </button>
  );
}
