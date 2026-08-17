"use client";

import { TEAM } from "../../lib/members";
import { ChatIcon, GitBranchIcon, LayoutIcon, SparkleIcon, TerminalIcon } from "../icons";
import { Avatar } from "./chat";

type TopBarProps = {
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
      <span className="flex shrink-0 items-center gap-1.5 text-[13px] font-semibold text-vs-fg">
        <SparkleIcon className="h-4 w-4 text-vs-accent" />
        <span className="whitespace-nowrap">
          multiplayer<span className="text-vs-muted">-ai</span>
        </span>
      </span>

      <button
        type="button"
        onClick={onOpenFolder}
        className="rounded px-2 py-0.5 text-xs text-vs-muted transition hover:bg-vs-hover hover:text-vs-fg"
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
