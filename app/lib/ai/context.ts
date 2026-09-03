import { query } from "../db/client";
import { visibleRoomIds } from "../project/store";

/**
 * The "@room/chat" reference layer.
 *
 * A prompt can point at another chat with an `@<room>/<run-id>` token. When it
 * does, we pull that chat's most relevant conversations — ranked against the
 * asker's own prompt, capped at the last N — and weave them into the agent
 * prompt as <referenced-context>. Unlike a fork (which copies a whole transcript
 * into a new chat's memory once), a reference is resolved fresh on every turn
 * and is bounded and query-targeted, so it stays cheap and works mid-thread.
 *
 * Access is never widened here: a reference only resolves to a run whose room
 * the caller can already see (visibleRoomIds), so this can't leak another team's
 * chat.
 */

/** A run id anywhere in text — the parseable half of an `@room/<run-id>` token. */
export const RUN_ID_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Default number of conversations (a user turn + its agent reply) kept per chat. */
export const PER_CHAT_CONVERSATIONS = 10;

/** Cap on a single turn's length when formatted, so one reply can't swamp the budget. */
const MAX_TURN_CHARS = 4000;

export type ReferenceSource = { runId: string; sessionName: string; title: string | null };

type Conversation = {
  startSeq: number;
  userName: string | null;
  userText: string;
  agentText: string;
  rank: number;
};

/** Pull every run id out of free text (picked tokens, or a pasted chat path). */
export function extractRunIds(text: string): string[] {
  const found = text.match(RUN_ID_RE) ?? [];
  return [...new Set(found.map((id) => id.toLowerCase()))];
}

/** Remove `@room/<run-id>` noise from a prompt before using it as a search query. */
function toSearchQuery(prompt: string): string {
  return prompt.replace(RUN_ID_RE, " ").replace(/@\S*/g, " ").replace(/\s+/g, " ").trim();
}

const clip = (body: string): string =>
  body.length > MAX_TURN_CHARS ? `${body.slice(0, MAX_TURN_CHARS)}\n[…truncated]` : body;

/**
 * Runs the caller wants to reference, filtered to the ones whose room they may
 * actually see. Returns them in the order requested, dropping any that are
 * hidden or don't exist — silently, since a stale token shouldn't fail the run.
 */
export async function resolveReferences(
  projectId: string,
  userId: string,
  runIds: string[],
): Promise<ReferenceSource[]> {
  if (runIds.length === 0) return [];
  const rooms = await visibleRoomIds(projectId, userId);
  if (rooms.size === 0) return [];

  const rows = await query<{ id: string; session_name: string; title: string | null }>(
    `SELECT r.id, s.name AS session_name, r.title
       FROM agent_runs r
       JOIN sessions s ON s.id = r.session_id
      WHERE r.id = ANY($1) AND r.session_id = ANY($2)`,
    [runIds, [...rooms]],
  );

  const byId = new Map(
    rows.map((row) => [row.id, { runId: row.id, sessionName: row.session_name, title: row.title }]),
  );
  return runIds.map((id) => byId.get(id)).filter((r): r is ReferenceSource => Boolean(r));
}

/**
 * The most relevant conversations of one chat. When `search` matches, the
 * top-ranked conversations win (then re-sorted into reading order); otherwise
 * it falls back to the most recent ones. Only user/agent turns count — system
 * and tool output is operational noise.
 */
async function relevantConversations(
  runId: string,
  search: string,
  limit: number,
): Promise<Conversation[]> {
  const rows = await query<{
    seq: string;
    role: "user" | "agent";
    author_name: string | null;
    body: string;
    rank: number;
  }>(
    `SELECT m.seq, m.role, u.display_name AS author_name, m.body,
            ts_rank(to_tsvector('english', m.body),
                    websearch_to_tsquery('english', $2)) AS rank
       FROM agent_run_messages m
       LEFT JOIN users u ON u.id = m.author_user_id
      WHERE m.run_id = $1 AND m.role IN ('user', 'agent')
      ORDER BY m.seq`,
    [runId, search],
  );

  // Group turns into conversations: each user turn opens one, following agent
  // turns fill its reply until the next user turn.
  const convs: Conversation[] = [];
  let current: Conversation | null = null;
  for (const row of rows) {
    const seq = Number(row.seq);
    if (row.role === "user") {
      current = {
        startSeq: seq,
        userName: row.author_name,
        userText: row.body,
        agentText: "",
        rank: Number(row.rank) || 0,
      };
      convs.push(current);
    } else {
      if (!current) {
        current = { startSeq: seq, userName: null, userText: "", agentText: "", rank: 0 };
        convs.push(current);
      }
      current.agentText += (current.agentText ? "\n" : "") + row.body;
      current.rank += Number(row.rank) || 0;
    }
  }

  const ranked = search && convs.some((c) => c.rank > 0);
  const chosen = ranked
    ? [...convs].sort((a, b) => b.rank - a.rank).slice(0, limit)
    : convs.slice(-limit);
  // Always present the kept conversations in reading (chronological) order.
  return chosen.sort((a, b) => a.startSeq - b.startSeq);
}

function formatConversation(conv: Conversation): string {
  const who = conv.userName ? `User (${conv.userName})` : "User";
  const parts: string[] = [];
  if (conv.userText.trim()) parts.push(`${who}: ${clip(conv.userText.trim())}`);
  if (conv.agentText.trim()) parts.push(`Agent: ${clip(conv.agentText.trim())}`);
  return parts.join("\n");
}

/**
 * Build the injectable <referenced-context> block for a prompt, plus the list of
 * chats it drew from (for the transcript notice). Returns null text when no
 * reference resolves to anything.
 */
export async function buildReferencedContext(input: {
  projectId: string;
  userId: string;
  runIds: string[];
  prompt: string;
  perChat?: number;
}): Promise<{ text: string | null; sources: ReferenceSource[] }> {
  const sources = await resolveReferences(input.projectId, input.userId, input.runIds);
  if (sources.length === 0) return { text: null, sources: [] };

  const search = toSearchQuery(input.prompt);
  const perChat = input.perChat ?? PER_CHAT_CONVERSATIONS;

  const blocks: string[] = [];
  const used: ReferenceSource[] = [];
  for (const source of sources) {
    const convs = await relevantConversations(source.runId, search, perChat);
    const body = convs.map(formatConversation).filter(Boolean).join("\n\n");
    if (!body) continue;
    const label = source.title ? `${source.sessionName} · ${source.title}` : source.sessionName;
    blocks.push(`### From @${label}\n${body}`);
    used.push(source);
  }

  if (blocks.length === 0) return { text: null, sources: [] };
  return { text: blocks.join("\n\n"), sources: used };
}
