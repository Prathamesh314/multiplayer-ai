"use client";

import { useSyncExternalStore } from "react";
import type { RunHandle } from "../../lib/ai/client";
import type { MessageAttachment } from "../../lib/events/types";

/** One line of the conversation, whether streamed live or read from history. */
export type Turn = {
  id: string;
  role: "user" | "agent" | "system";
  text: string;
  /** Files sent with a user message. */
  attachments?: MessageAttachment[];
  author?: string | null;
  agentName?: string | null;
  /** True while the agent is still writing into this turn. */
  streaming?: boolean;
  /** Live reasoning trace (Claude's thinking) — ephemeral, not stored. */
  thinking?: string;
  /** Tool steps as they happen, e.g. "Read app/x.ts" — ephemeral, not stored. */
  activities?: string[];
  /** Epoch ms this agent turn began, for the live elapsed timer. */
  startedAt?: number;
  /** A failed run: what went wrong in one sentence, and the tool's output as its log. */
  failure?: { message: string; log: string };
  /** A notice that opens another chat: "Imported context from …" links to its source. */
  source?: { sessionId: string; runId: string };
  /**
   * The run's stderr, live. Nothing the AI emits is hidden from the chat: the
   * log is always openable under the turn, and surfaces expanded when the run
   * fails — that's where the reason lives.
   */
  errText?: string;
  /** Set from the exit event when the run ended non-zero. */
  failed?: boolean;
  /** A live "waiting for your computer" line, removed once the agent starts. */
  waiting?: boolean;
};

/**
 * What one chat holds in this tab, whether or not it is on screen. A turn this
 * tab sends streams into its own chat's entry, so opening another chat, or a
 * new one, changes only what is shown: the first keeps working and keeps its
 * output.
 */
export type ChatState = {
  turns: Turn[];
  /** This tab is streaming a turn of this chat. */
  sending: boolean;
  /** This tab sent the chat's latest turn and has its complete output. */
  drove: boolean;
  error: string | null;
  historyFailed: boolean;
  /** The run, once the server has opened it; a new chat has none until then. */
  runId: string | null;
  handle: RunHandle | null;
};

const EMPTY: ChatState = { turns: [], sending: false, drove: false, error: null, historyFailed: false, runId: null, handle: null };

/** A key for a chat that has not been sent yet. */
export const draftKey = () => `draft:${crypto.randomUUID()}`;
export const isDraftKey = (key: string) => key.startsWith("draft:");

/**
 * Every chat of one room in this tab, keyed by run id, or by a draft key until
 * the server names the run. A draft that starts is aliased to its run id, so a
 * late event addressed to the draft still lands in the right chat.
 */
export class ChatStore {
  private chats = new Map<string, ChatState>();
  private aliases = new Map<string, string>();
  private listeners = new Set<() => void>();

  resolve(key: string): string {
    return this.aliases.get(key) ?? key;
  }

  get(key: string): ChatState {
    return this.chats.get(this.resolve(key)) ?? EMPTY;
  }

  update(key: string, change: (chat: ChatState) => ChatState) {
    const resolved = this.resolve(key);
    const before = this.chats.get(resolved) ?? EMPTY;
    const after = change(before);
    if (after === before) return;
    this.chats.set(resolved, after);
    this.emit();
  }

  /** A draft became run `runId`: its state moves there and the draft key follows it. */
  started(key: string, runId: string) {
    const resolved = this.resolve(key);
    if (resolved === runId) return;
    const state = this.chats.get(resolved) ?? EMPTY;
    this.chats.delete(resolved);
    this.chats.set(runId, { ...state, runId });
    this.aliases.set(key, runId);
    this.emit();
  }

  /** The run ids this tab is sending to right now. */
  sendingRunIds(): Set<string> {
    const ids = new Set<string>();
    for (const [key, chat] of this.chats) if (chat.sending) ids.add(chat.runId ?? key);
    return ids;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  /** Leaving the room stops reading its streams; the agents keep working. */
  dispose() {
    for (const chat of this.chats.values()) chat.handle?.cancel();
  }

  private emit() {
    for (const listener of this.listeners) listener();
  }
}

export function useChat(store: ChatStore, key: string): ChatState {
  return useSyncExternalStore(store.subscribe, () => store.get(key), () => EMPTY);
}
