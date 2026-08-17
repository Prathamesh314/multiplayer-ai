"use client";

import { useState } from "react";
import { TEAM } from "../../lib/members";
import { SparkleIcon } from "../icons";
import type { ChatMessage } from "./chat";
import { Avatar, clockNow, Composer, MessageList, nextMessageId } from "./chat";
import { baseName } from "./EditorArea";
import { PanelHeader } from "./TeamChatPanel";

type AiPanelProps = {
  activePath: string | null;
  onClose: () => void;
};

export function AiPanel({ activePath, onClose }: AiPanelProps) {
  const [selectedId, setSelectedId] = useState(TEAM[1].id);
  const [threads, setThreads] = useState<Record<string, ChatMessage[]>>({});

  const selected = TEAM.find((member) => member.id === selectedId) ?? TEAM[0];
  const messages = threads[selectedId] ?? [];

  function send(text: string) {
    setThreads((previous) => ({
      ...previous,
      [selectedId]: [
        ...(previous[selectedId] ?? []),
        { id: nextMessageId("ai"), authorId: "you", text, time: clockNow() },
      ],
    }));
  }

  return (
    <aside className="flex h-full min-h-0 w-full flex-col bg-vs-panel">
      <PanelHeader title="AI" onClose={onClose}>
        <SparkleIcon className="h-4 w-4 text-vs-muted" />
      </PanelHeader>

      <div className="shrink-0 border-b border-vs-border px-3 py-2.5">
        <p className="mb-2 text-[10px] uppercase tracking-wider text-vs-muted">
          Online team members
        </p>
        <div className="flex flex-wrap items-center gap-2.5">
          {TEAM.map((member) => (
            <button
              key={member.id}
              type="button"
              onClick={() => setSelectedId(member.id)}
              title={`${member.name} · ${member.role}`}
              aria-pressed={member.id === selectedId}
              className="transition hover:opacity-80"
            >
              <Avatar member={member} selected={member.id === selectedId} />
            </button>
          ))}
        </div>
      </div>

      <div className="shrink-0 border-b border-vs-border px-3 py-2">
        <p className="text-[13px] font-semibold text-vs-fg">{selected.name}&apos;s AI</p>
        <p className="mt-0.5 truncate text-[11px] text-vs-muted">
          {activePath ? `Context: ${baseName(activePath)}` : "No file open"}
        </p>
      </div>

      <MessageList
        messages={messages}
        authorOf={(authorId) => authorOf(authorId, selected.id)}
        emptyState={
          <p className="max-w-56 text-center text-xs leading-5 text-vs-muted">
            Ask {selected.name.split(" ")[0]}&apos;s AI about the open file, a diff, or where
            something lives.
          </p>
        }
      />

      <p className="border-t border-vs-border px-3 py-1.5 text-[10px] leading-4 text-vs-muted">
        No model is connected yet, so messages stay in this panel and go unanswered.
      </p>

      <Composer placeholder="type here." onSend={send} />
    </aside>
  );
}

function authorOf(authorId: string, selectedId: string) {
  const id = authorId === "ai" ? selectedId : authorId;
  const member = TEAM.find((candidate) => candidate.id === id) ?? TEAM[0];
  return {
    name: authorId === "ai" ? `${member.name}'s AI` : member.name,
    avatar: <Avatar member={member} size="sm" />,
  };
}
