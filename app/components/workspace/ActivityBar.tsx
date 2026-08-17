"use client";

import { ChatIcon, FilesIcon, SparkleIcon, TerminalIcon } from "../icons";

type ActivityBarProps = {
  chatOpen: boolean;
  explorerOpen: boolean;
  aiOpen: boolean;
  terminalOpen: boolean;
  onToggleChat: () => void;
  onToggleExplorer: () => void;
  onToggleAi: () => void;
  onToggleTerminal: () => void;
};

export function ActivityBar({
  chatOpen,
  explorerOpen,
  aiOpen,
  terminalOpen,
  onToggleChat,
  onToggleExplorer,
  onToggleAi,
  onToggleTerminal,
}: ActivityBarProps) {
  return (
    <nav
      aria-label="Panels"
      className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-vs-border bg-vs-chrome py-2"
    >
      <Item label="Team chat" active={chatOpen} onClick={onToggleChat}>
        <ChatIcon className="h-5 w-5" />
      </Item>
      <Item label="Explorer" active={explorerOpen} onClick={onToggleExplorer}>
        <FilesIcon className="h-5 w-5" />
      </Item>
      <Item label="AI" active={aiOpen} onClick={onToggleAi}>
        <SparkleIcon className="h-5 w-5" />
      </Item>
      <Item label="Terminal (Ctrl+Shift+Z)" active={terminalOpen} onClick={onToggleTerminal}>
        <TerminalIcon className="h-5 w-5" />
      </Item>
    </nav>
  );
}

function Item({
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
      className={`relative flex h-10 w-full items-center justify-center transition ${
        active ? "text-vs-fg" : "text-vs-muted hover:text-vs-fg"
      }`}
    >
      {active && <span className="absolute left-0 h-6 w-0.5 rounded-r bg-vs-accent" />}
      {children}
    </button>
  );
}
