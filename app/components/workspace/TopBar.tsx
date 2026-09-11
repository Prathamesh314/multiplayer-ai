"use client";

import { useState } from "react";
import { publishRoom, syncRoom } from "../../lib/session/client";
import { canEdit, type Session, type SessionMember } from "../../lib/session/types";
import { GitBranchIcon, SparkleIcon, TerminalIcon, UserPlusIcon } from "../icons";
import { PeopleStack } from "./People";

type TopBarProps = {
  onOpenGuide: () => void;
  session: Session;
  onInvite: () => void;
  onLeave: () => void;
  folderName: string | null;
  branch: string | null;
  isGit: boolean;
  terminalOpen: boolean;
  onToggleTerminal: () => void;
  onOpenFolder: () => void;
  /** False once this session owns a repo — a session is seeded exactly once. */
  canOpenFolder: boolean;
  members: SessionMember[];
  importedRepo?: boolean;
};

export function TopBar({
  onOpenGuide,
  session,
  onInvite,
  onLeave,
  folderName,
  branch,
  isGit,
  terminalOpen,
  onToggleTerminal,
  onOpenFolder,
  canOpenFolder,
  members,
  importedRepo = false,
}: TopBarProps) {
  return (
    <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-2 py-2 border-b border-vs-border bg-vs-chrome px-3">
      <button
        type="button"
        onClick={onLeave}
        title="Back to projects"
        className="flex shrink-0 items-center gap-1.5 rounded px-1 text-[14px] font-semibold text-vs-fg transition hover:bg-vs-hover"
      >
        <SparkleIcon className="h-4 w-4 text-vs-accent" />
        <span className="whitespace-nowrap">
          multiplayer<span className="text-vs-muted">-ai</span>
        </span>
      </button>

      <span
        title={`Session ${session.id}`}
        className="max-w-36 min-w-0 truncate rounded bg-vs-hover px-2 py-0.5 text-sm text-vs-fg"
      >
        {session.name}
      </span>

      {canOpenFolder && (
        <button
          type="button"
          onClick={onOpenFolder}
          className="shrink-0 rounded px-2 py-0.5 text-sm text-vs-muted transition hover:bg-vs-hover hover:text-vs-fg"
        >
          Open folder…
        </button>
      )}

      <div className="mx-auto hidden min-w-0 lg:flex items-center gap-2 rounded border border-vs-border bg-vs-panel px-3 py-1 text-sm text-vs-muted">
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

      {session.projectId && !importedRepo && canEdit(session.myRole) && (
        <PublishControls sessionId={session.id} />
      )}

      <div className="ml-auto hidden sm:block"><PeopleStack members={members} /></div>

      <button type="button" onClick={onOpenGuide} className="shrink-0 rounded-lg border border-vs-border px-3 py-1.5 text-sm hover:bg-vs-hover">Room guide</button>

      <button
        type="button"
        onClick={onInvite}
        className="flex shrink-0 items-center gap-1.5 rounded bg-vs-accent px-2.5 py-1 text-sm font-medium text-vs-accent-fg transition hover:opacity-90"
      >
        <UserPlusIcon className="h-3.5 w-3.5" />
        Invite
      </button>

      <div className="hidden items-center gap-0.5 sm:flex">
        <ToggleButton
          label="Toggle terminal (Ctrl+Shift+Z)"
          active={terminalOpen}
          onClick={onToggleTerminal}
        >
          <TerminalIcon className="h-4 w-4" />
        </ToggleButton>
      </div>
    </header>
  );
}

/**
 * Sync from / publish to the project's shared main — the Git/Branch model made
 * visible. A room is a branch; these are its pull and merge-back.
 */
function PublishControls({ sessionId }: { sessionId: string }) {
  const [busy, setBusy] = useState<"publish" | "sync" | null>(null);
  const [status, setStatus] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  async function run(kind: "publish" | "sync") {
    setBusy(kind);
    setStatus(null);
    try {
      const outcome = await (kind === "publish" ? publishRoom(sessionId) : syncRoom(sessionId));
      if (outcome.ok) {
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
        disabled={busy !== null}
        title="Pull the project's latest main into this room"
        className="rounded px-2 py-1 text-sm text-vs-muted transition hover:bg-vs-hover hover:text-vs-fg disabled:opacity-50"
      >
        {busy === "sync" ? "Syncing…" : "Get latest"}
      </button>
      <button
        type="button"
        onClick={() => run("publish")}
        disabled={busy !== null}
        title="Merge saved room changes into the shared project, not GitHub. Review Changes first."
        className="flex items-center gap-1 rounded border border-vs-border px-2 py-1 text-sm text-vs-fg transition hover:bg-vs-hover disabled:opacity-50"
      >
        <GitBranchIcon className="h-3 w-3" />
        {busy === "publish" ? "Publishing…" : "Publish"}
      </button>
      {status && (
        <span
          className={`max-w-64 truncate text-[12px] ${status.tone === "ok" ? "text-vs-success" : "text-vs-danger"}`}
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
