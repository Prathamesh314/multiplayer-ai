"use client";

import { useState } from "react";
import { TEAM } from "../../lib/members";
import { CloseIcon } from "../icons";
import type { ChatMessage } from "./chat";
import { Avatar, clockNow, Composer, MessageList, nextMessageId } from "./chat";

const SEEDED: ChatMessage[] = [
  { id: "seed-1", authorId: "ada", text: "Pushed the scanner refactor — explorer should feel snappier now.", time: "09:41" },
  { id: "seed-2", authorId: "grace", text: "Nice. I'll take the editor gutter alignment next.", time: "09:44" },
];

export function TeamChatPanel({ onClose }: { onClose: () => void }) {
  const [messages, setMessages] = useState<ChatMessage[]>(SEEDED);

  return (
    <aside className="flex h-full min-h-0 w-full flex-col bg-vs-panel">
      <PanelHeader title="Team chat" onClose={onClose}>
        <div className="flex -space-x-1.5">
          {TEAM.filter((member) => member.status !== "offline").map((member) => (
            <Avatar key={member.id} member={member} size="sm" />
          ))}
        </div>
      </PanelHeader>

      <MessageList
        messages={messages}
        authorOf={authorOf}
        emptyState={<p className="text-center text-xs text-vs-muted">No messages yet.</p>}
      />

      <p className="px-3 pb-1 text-[10px] leading-4 text-vs-muted">
        Local preview only — realtime sync is not connected yet.
      </p>

      <Composer
        placeholder="Message the team…"
        onSend={(text) =>
          setMessages((previous) => [
            ...previous,
            { id: nextMessageId("team"), authorId: "you", text, time: clockNow() },
          ])
        }
      />
    </aside>
  );
}

function authorOf(authorId: string) {
  const member = TEAM.find((candidate) => candidate.id === authorId) ?? TEAM[0];
  return { name: member.name, avatar: <Avatar member={member} size="sm" /> };
}

export function PanelHeader({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose?: () => void;
  children?: React.ReactNode;
}) {
  return (
    <header className="flex h-9 shrink-0 items-center gap-2 border-b border-vs-border px-3">
      <h2 className="text-[11px] font-semibold uppercase tracking-wider text-vs-muted">{title}</h2>
      <div className="ml-auto flex items-center gap-2">
        {children}
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label={`Close ${title}`}
            className="rounded p-0.5 text-vs-muted transition hover:bg-vs-hover hover:text-vs-fg"
          >
            <CloseIcon className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </header>
  );
}
