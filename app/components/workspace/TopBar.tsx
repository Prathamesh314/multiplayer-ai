"use client";

import { useState } from "react";
import { publishRoom, syncRoom } from "../../lib/session/client";
import { canEdit, type Session, type SessionMember } from "../../lib/session/types";
import { GitBranchIcon, SparkleIcon, TerminalIcon, UserPlusIcon } from "../icons";
import { PeopleStack } from "./People";

type TopBarProps = {
  onOpenMemory: () => void;
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
  repoId: string | null;
  hasRepository: boolean;
  sharedRepository: boolean;
  beforePublish: () => Promise<boolean>;
  onPublished: () => Promise<void>;
};

export function TopBar({
  onOpenMemory,
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
  repoId, hasRepository, sharedRepository, beforePublish, onPublished,
}: TopBarProps) {
  return (
    <header className="room-toolbar flex shrink-0 items-center gap-3 border-b border-vs-border bg-vs-chrome px-3">
      {/* Identity: where am I. */}
      <div className="flex min-w-0 items-center gap-1.5">
        <button type="button" onClick={onLeave} title="Back to projects" className="ui-control ui-control--strong">
          <SparkleIcon className="h-3.5 w-3.5 text-vs-accent" />
          <span>multiplayer<span className="text-vs-muted">-ai</span></span>
        </button>
        <span aria-hidden="true" className="text-vs-muted/40">/</span>
        <span title={`Session ${session.id}`} className="min-w-0 max-w-56 truncate px-1 text-chrome font-medium text-vs-fg">
          {session.name}
        </span>
      </div>

      {/* Context: what am I working on. Read-only, so it carries no affordance. */}
      <div className="ml-auto flex min-w-0 items-center gap-1.5">
        <div className="hidden min-w-0 max-w-56 xl:flex">
          <span className="ui-readout min-w-0">
            <span className="truncate">{folderName ?? "No folder open"}</span>
            {folderName && isGit && branch && (
              <span className="inline-flex shrink-0 items-center gap-1 font-mono text-vs-fg">
                <GitBranchIcon className="h-3 w-3" />
                {branch}
              </span>
            )}
          </span>
        </div>
        {canOpenFolder && (
          <button type="button" onClick={onOpenFolder} className="ui-control">Open folder…</button>
        )}
      </div>

      {/* Repository actions. */}
      {session.projectId && hasRepository && canEdit(session.myRole) && (
        <>
          <span aria-hidden="true" className="ui-divider" />
          <PublishControls key={repoId ?? "legacy"} sessionId={session.id} repoId={repoId} shared={sharedRepository} beforePublish={beforePublish} onPublished={onPublished} />
        </>
      )}

      <span aria-hidden="true" className="ui-divider hidden sm:block" />

      {/* People and room actions. Invite is the one solid control in the bar. */}
      <div className="flex shrink-0 items-center gap-1.5">
        <div className="hidden sm:block"><PeopleStack members={members} /></div>
        <button type="button" onClick={onOpenGuide} className="ui-control">Room guide</button>
        <button type="button" onClick={onOpenMemory} className="ui-control">Memory</button>
        <button type="button" onClick={onInvite} className="ui-control ui-control--solid">
          <UserPlusIcon className="h-3.5 w-3.5" />
          Invite
        </button>
        <ToggleButton label="Toggle terminal (Ctrl+Shift+Z)" active={terminalOpen} onClick={onToggleTerminal}>
          <TerminalIcon className="h-4 w-4" />
        </ToggleButton>
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
    <div className="flex shrink-0 items-center gap-1.5">
      <button
        type="button"
        onClick={() => run("sync")}
        disabled={busy !== null || !shared}
        title="Get the selected repository’s latest shared changes"
        className="ui-control"
      >
        {busy === "sync" ? "Syncing…" : "Get latest"}
      </button>
      <button
        type="button"
        onClick={() => run("publish")}
        disabled={busy !== null}
        title="Share saved changes in the selected repository with project members. Review Changes first."
        className="ui-control ui-control--outline"
      >
        <GitBranchIcon className="h-3 w-3" />
        {busy === "publish" ? "Publishing…" : shared ? "Publish" : "Share repository"}
      </button>
      {status && (
        <span
          className={`max-w-64 truncate text-chrome ${status.tone === "ok" ? "text-vs-success" : "text-vs-danger"}`}
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
      className="ui-control ui-control--icon"
    >
      {children}
    </button>
  );
}
