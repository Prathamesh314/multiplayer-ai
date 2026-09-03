/*
 * The semantic shared-memory layer.
 *
 * This sits alongside the two existing context mechanisms — fork (whole
 * transcript copied once, see memory.ts) and `@room/chat` FTS reference
 * (context.ts) — and adds the piece neither has: cross-chat semantic recall,
 * distilled over time by the mnemosyne sidecar. Where the FTS reference answers
 * "pull the relevant bits of *this specific* chat", this answers "surface what
 * we've learned across *all* the chats this person can see", ranked by meaning
 * rather than keyword overlap.
 *
 * Access is never widened here. Each room's memories live in their own bank
 * (`session:<id>`), and recall only ever fans out over the caller's
 * visibleRoomIds — the same gate the FTS reference layer uses — so one team's
 * memory can't surface in another's prompt.
 */

import { visibleRoomIds } from "../project/store";
import { recall, remember, memoryEnabled } from "./mnemosyne";
import type { Memory } from "./mnemosyne";

/** A room's memory bank. One bank per room keeps recall access-scoped per room. */
export function roomBank(sessionId: string): string {
  return `session:${sessionId}`;
}

/**
 * Cap on how many rooms one recall fans out over. Recall issues one backend call
 * per bank, so an unbounded project would mean an unbounded number of calls on
 * the run's critical path. The caller's own room is always included; the rest
 * are the most-recently-visible ones. When we truncate, the caller is told
 * (buildSharedMemory returns `truncatedRooms`) rather than silently narrowing.
 */
const MAX_BANKS = 8;
/** Memories kept per bank before the cross-bank merge. */
const PER_BANK = 4;
/** Memories kept after merging every bank's hits. */
const TOTAL = 8;
/** One memory can't run away with the prompt budget. */
const MAX_MEMORY_CHARS = 800;

const clip = (text: string): string =>
  text.length > MAX_MEMORY_CHARS ? `${text.slice(0, MAX_MEMORY_CHARS)}…` : text;

/**
 * Build the injectable <memory> block: the most relevant distilled memories
 * across the rooms this caller can see, ranked by the mnemosyne sidecar and
 * merged into one list. Returns null text when memory is off, nothing matched,
 * or the sidecar is unreachable — all of which are non-fatal for the run.
 *
 * `currentSessionId` is always searched and always counts against the bank cap
 * first, so a chat can always recall its own memory even in a huge project.
 */
export async function buildSharedMemory(input: {
  projectId: string;
  userId: string;
  currentSessionId: string;
  prompt: string;
}): Promise<{ text: string | null; recalled: number; truncatedRooms: number }> {
  if (!memoryEnabled() || !input.prompt.trim()) {
    return { text: null, recalled: 0, truncatedRooms: 0 };
  }

  const visible = await visibleRoomIds(input.projectId, input.userId);
  // Current room first, then the rest, so the cap never drops the caller's own.
  const ordered = [
    input.currentSessionId,
    ...[...visible].filter((id) => id !== input.currentSessionId),
  ].filter((id) => visible.has(id) || id === input.currentSessionId);

  const chosen = ordered.slice(0, MAX_BANKS);
  const truncatedRooms = Math.max(0, ordered.length - chosen.length);

  const perBank = await Promise.all(
    chosen.map((sessionId) =>
      recall({ bank: roomBank(sessionId), query: input.prompt, topK: PER_BANK }),
    ),
  );

  // Merge, drop exact-duplicate memories (the sidecar distills across rooms, but
  // the same fact can still surface from two banks), and keep the top by score.
  const seen = new Set<string>();
  const merged: Memory[] = [];
  for (const memory of perBank.flat()) {
    const key = memory.content.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(memory);
  }
  merged.sort((a, b) => b.score - a.score || b.importance - a.importance);
  const top = merged.slice(0, TOTAL);

  if (top.length === 0) return { text: null, recalled: 0, truncatedRooms };

  const text = top.map((memory) => `- ${clip(memory.content.trim())}`).join("\n");
  return { text, recalled: top.length, truncatedRooms };
}

/**
 * Importance heuristic for an ingested turn. A turn whose run actually changed
 * files is worth more than a chat that produced nothing, and longer exchanges
 * carry more substance than a one-liner — but everything stays in a modest band
 * so nothing dominates recall outright.
 */
function importanceFor(input: { changed: boolean; length: number }): number {
  const base = input.changed ? 0.6 : 0.4;
  const lengthBonus = Math.min(0.2, input.length / 20_000);
  return Math.min(0.9, base + lengthBonus);
}

/**
 * Ingest one completed exchange into the room's memory bank. Called after a run
 * finishes, with the user's prompt and the agent's reply already persisted.
 * Best-effort: a failed write is dropped, never surfaced to the run.
 */
export async function ingestExchange(input: {
  sessionId: string;
  prompt: string;
  reply: string;
  changed: boolean;
}): Promise<void> {
  if (!memoryEnabled()) return;
  const reply = input.reply.trim();
  const prompt = input.prompt.trim();
  if (!prompt && !reply) return;

  const content = [prompt && `User: ${prompt}`, reply && `Agent: ${reply}`]
    .filter(Boolean)
    .join("\n");

  await remember({
    bank: roomBank(input.sessionId),
    content,
    importance: importanceFor({ changed: input.changed, length: content.length }),
    channelId: input.sessionId,
    source: "chat",
  });
}
