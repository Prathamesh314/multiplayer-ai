"use client";

import { TEAM } from "../../lib/members";
import type { Session } from "../../lib/session/types";
import {
  ChatIcon,
  GitBranchIcon,
  LayoutIcon,
  SparkleIcon,
  TerminalIcon,
  UserPlusIcon,
} from "../icons";
import { Avatar } from "./chat";

type TopBarProps = {
  session: Session;
  onInvite: () => void;
  onLeave: () => void;
  folderName: string | null;
  branch: string | null;
  isGit: boolean;
  chatOpen: boolean;
  explorerOpen: boolean;
  aiOpen: boolean;
  terminalOpen: boolean;
  onToggleChat: () => void;
  onToggleExplorer: () => void;
  onToggleAi: () => void;
  onToggleTerminal: () => void;
  onOpenFolder: () => void;
};

export function TopBar({
  session,
  onInvite,
  onLeave,
  folderName,
  branch,
  isGit,
  chatOpen,
  explorerOpen,
  aiOpen,
  terminalOpen,
  onToggleChat,
  onToggleExplorer,
  onToggleAi,
  onToggleTerminal,
  onOpenFolder,
}: TopBarProps) {
  return (
    <header className="flex h-9 shrink-0 items-center gap-3 border-b border-vs-border bg-vs-chrome px-3">
      <button
        type="button"
        onClick={onLeave}
        title="Back to all sessions"
        className="flex shrink-0 items-center gap-1.5 rounded px-1 text-[13px] font-semibold text-vs-fg transition hover:bg-vs-hover"
      >
        <SparkleIcon className="h-4 w-4 text-vs-accent" />
        <span className="whitespace-nowrap">
          multiplayer<span className="text-vs-muted">-ai</span>
        </span>
      </button>

      <span
        title={`Session ${session.id}`}
        className="max-w-48 shrink-0 truncate rounded bg-vs-hover px-2 py-0.5 text-xs text-vs-fg"
      >
        {session.name}
      </span>

      <button
        type="button"
        onClick={onOpenFolder}
        className="shrink-0 rounded px-2 py-0.5 text-xs text-vs-muted transition hover:bg-vs-hover hover:text-vs-fg"
      >
        Open folder…
      </button>

      <div className="mx-auto flex min-w-0 items-center gap-2 rounded border border-vs-border bg-vs-panel px-3 py-1 text-xs text-vs-muted">
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

      <div className="flex -space-x-1.5">
        {TEAM.filter((member) => member.status !== "offline").map((member) => (
          <Avatar key={member.id} member={member} size="sm" />
        ))}
      </div>

      <button
        type="button"
        onClick={onInvite}
        className="flex shrink-0 items-center gap-1.5 rounded bg-vs-accent px-2.5 py-1 text-xs font-medium text-vs-accent-fg transition hover:opacity-90"
      >
        <UserPlusIcon className="h-3.5 w-3.5" />
        Invite
      </button>

      <div className="flex items-center gap-0.5">
        <ToggleButton label="Toggle team chat" active={chatOpen} onClick={onToggleChat}>
          <ChatIcon className="h-4 w-4" />
        </ToggleButton>
        <ToggleButton label="Toggle explorer" active={explorerOpen} onClick={onToggleExplorer}>
          <LayoutIcon side="left" className="h-4 w-4" />
        </ToggleButton>
        <ToggleButton
          label="Toggle terminal (Ctrl+Shift+Z)"
          active={terminalOpen}
          onClick={onToggleTerminal}
        >
          <TerminalIcon className="h-4 w-4" />
        </ToggleButton>
        <ToggleButton label="Toggle AI panel" active={aiOpen} onClick={onToggleAi}>
          <LayoutIcon side="right" className="h-4 w-4" />
        </ToggleButton>
      </div>
    </header>
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
