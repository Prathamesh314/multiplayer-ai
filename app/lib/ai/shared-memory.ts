/*
 * The shared-memory *write* path: folding finished exchanges into a room's
 * memory bank, and scheduling the consolidation that distills them.
 *
 * Reading — which banks a prompt recalls from, and in what order — lives in
 * the knowledge layer (app/lib/knowledge/), which routes each prompt over the
 * project's knowledge graph. This module is the ingest side of that graph, and
 * it is **approval-gated**:
 *
 * - An exchange whose run *changed files* is not knowledge yet — it is a
 *   proposal the human hasn't accepted. It is staged in Postgres
 *   (`staged_memory_exchanges`, migration 019) and ingested only when the user
 *   approves the code by publishing the room to the project's `main`
 *   (`ingestApprovedExchanges`, called from the publish route). Work that is
 *   never published never becomes shared memory.
 * - A pure Q&A exchange (no commit produced) has no code to approve, so it
 *   ingests immediately, as it always did.
 *
 * Access framing is unchanged: each room's memories live in their own bank
 * (`session-<id>`), so recall — however it is orchestrated — can only fan out
 * over banks whose rooms the caller can see.
 */

import { query } from "../db/client";
import { consolidationEnabled, scheduleConsolidation } from "../queue/consolidation";
import { remember, memoryEnabled } from "./mnemosyne";
import { roomBank } from "../knowledge/graph";
import { stageExchange } from "./memory-staging";

// The bank naming lives with the graph now; re-exported so the consolidation
// worker (worker/index.ts) keeps one import site for "the bank of this room".
export { roomBank };

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

/** The one canonical shape an exchange takes as memory content. */
function exchangeContent(prompt: string, reply: string): string {
  return [prompt && `User: ${prompt}`, reply && `Agent: ${reply}`].filter(Boolean).join("\n");
}

/** Write one exchange into its room's bank and keep consolidation armed. */
async function rememberExchange(input: {
  sessionId: string;
  prompt: string;
  reply: string;
  changed: boolean;
}): Promise<boolean> {
  const content = exchangeContent(input.prompt, input.reply);
  if (!content) return false;

  const stored = await remember({
    bank: roomBank(input.sessionId),
    content,
    importance: importanceFor({ changed: input.changed, length: content.length }),
    channelId: input.sessionId,
    source: "chat",
  });

  // With app-driven consolidation on, record the exchange for observability and
  // (re)arm the room's debounce timer, so a `sleep` fires once the room goes
  // quiet. Off by default: the `remember` above is all that happens, and the
  // sidecar's own AUTO_SLEEP (if enabled) consolidates on its own cadence.
  if (consolidationEnabled()) {
    await stageExchange(input.sessionId, {
      prompt: input.prompt,
      reply: input.reply,
      changed: input.changed,
      at: Date.now(),
    });
    await scheduleConsolidation(input.sessionId);
  }
  return stored;
}

/**
 * Ingest one completed exchange. Called after a run finishes, with the user's
 * prompt and the agent's reply already persisted. Best-effort: a failed write
 * is dropped, never surfaced to the run.
 *
 * Code-changing exchanges are *staged*, not remembered — see the module header.
 */
export async function ingestExchange(input: {
  sessionId: string;
  runId: string;
  prompt: string;
  reply: string;
  changed: boolean;
  /**
   * Whether this exchange's changes travel through the publish-approval flow.
   * True for the room's project fork (publish is the approval event). False
   * for an imported repo: it has no publish step, so gating would mean
   * "never" — its owner drives it directly, and the exchange ingests now.
   */
  publishGated: boolean;
}): Promise<void> {
  if (!memoryEnabled()) return;
  const reply = input.reply.trim();
  const prompt = input.prompt.trim();
  if (!prompt && !reply) return;

  if (input.changed && input.publishGated) {
    try {
      await query(
        `INSERT INTO staged_memory_exchanges (session_id, run_id, prompt, reply)
         VALUES ($1, $2, $3, $4)`,
        [input.sessionId, input.runId, prompt, reply],
      );
    } catch {
      // Staging is best-effort like every memory write; the exchange is lost
      // to memory but the run and its transcript are untouched.
    }
    return;
  }

  await rememberExchange({ sessionId: input.sessionId, prompt, reply, changed: input.changed });
}

/**
 * The approval event: the user published this room to the project's `main`,
 * accepting its work — so the room's staged exchanges become shared memory now.
 *
 * The drain is a single DELETE … RETURNING, so two racing publishes claim
 * disjoint rows and nothing is remembered twice. Claim-first means a sidecar
 * failure after the claim drops those exchanges (at-most-once) — consistent
 * with every other memory write being best-effort.
 */
export async function ingestApprovedExchanges(sessionId: string): Promise<number> {
  if (!memoryEnabled()) return 0;
  let drained: Array<{ prompt: string; reply: string }> = [];
  try {
    drained = await query<{ prompt: string; reply: string }>(
      `WITH drained AS (
         DELETE FROM staged_memory_exchanges
          WHERE session_id = $1
          RETURNING prompt, reply, created_at
       )
       SELECT prompt, reply FROM drained ORDER BY created_at`,
      [sessionId],
    );
  } catch {
    return 0;
  }

  let ingested = 0;
  for (const exchange of drained) {
    const stored = await rememberExchange({
      sessionId,
      prompt: exchange.prompt,
      reply: exchange.reply,
      changed: true,
    });
    if (stored) ingested += 1;
  }
  return ingested;
}
