/*
 * Assembling the one argv string sent to the agent CLI.
 *
 * A run weaves context layers around the user's prompt, all sharing
 * a single character budget (everything travels as one argv element). This is
 * pure string work with fiddly truncation rules, so it lives here — apart from
 * the run route's I/O and process management — where it can be reasoned about
 * and tested directly.
 *
 * Ordering (outermost → innermost, i.e. furthest from the prompt → nearest):
 *   <memory> · <repo-context> · <room-chat-context> · <imported-context> ·
 *   <referenced-context> · <conversation-history> · [prompt]
 * Budget priority is the reverse: the explicit, caller-chosen sources
 * (referenced, then imported) are woven first and take budget first; the
 * ambient, machine-recalled layers (repo context, then memory) take only what
 * is left and are dropped entirely if nothing remains. Repo context outranks
 * memory because it is the more directly actionable of the two for code edits.
 */

/** Hard cap on the whole argv string; also the validation limit in the route. */
export const MAX_PROMPT = 20_000;

/** Slack left for the wrapper tags and truncation notices around each block. */
const OVERHEAD = 120;

export type PromptContext = {
  /** The user's prompt, already trimmed. */
  prompt: string;
  /** Co-driver handle when the run has other authors; tags who is speaking. */
  handle?: string | null;
  /** Query-ranked slice of a referenced `@room/chat` (context.ts). */
  referencedContext?: string | null;
  conversationContext?: string | null;
  /** Whole transcript imported once when a chat was forked (memory.ts). */
  importedContext?: string | null;
  /** Indexed repo-context recall, when the router chose it (knowledge/). */
  repoContext?: string | null;
  /** Semantically recalled cross-chat memory (knowledge/). */
  sharedMemory?: string | null;
  /** Ranked human discussion excerpts with room/author/message provenance. */
  roomChatContext?: string | null;
  /** Overridable only for tests; defaults to MAX_PROMPT. */
  maxPrompt?: number;
};

/** Remaining budget for the next block, never negative. */
function remaining(current: string, maxPrompt: number): number {
  return Math.max(0, maxPrompt - current.length - OVERHEAD);
}

/**
 * Build the final agent prompt from the raw prompt plus whichever context layers
 * are present. Each layer is bounded to the budget left after the ones woven
 * before it, so the total stays within `maxPrompt` (modulo the small OVERHEAD
 * slack the tags themselves use).
 */
export function assembleAgentPrompt(ctx: PromptContext): string {
  const maxPrompt = ctx.maxPrompt ?? MAX_PROMPT;

  // On a co-driven run, tag who is speaking so two people's intents don't blur
  // into one contradictory instruction. Solo runs stay untagged.
  let agentPrompt = ctx.handle ? `[@${ctx.handle}] ${ctx.prompt}` : ctx.prompt;

  if (ctx.conversationContext) {
    const budget = remaining(agentPrompt, maxPrompt);
    if (budget > 0) {
      const recent = ctx.conversationContext.slice(-budget);
      agentPrompt = `<conversation-history>\n${recent}\n</conversation-history>\n\n${agentPrompt}`;
    }
  }

  // Referenced context is the curated, query-ranked slice the asker explicitly
  // pointed at, so it is woven first and keeps its head on truncation.
  if (ctx.referencedContext) {
    const budget = remaining(agentPrompt, maxPrompt);
    const injected =
      ctx.referencedContext.length > budget
        ? `${ctx.referencedContext.slice(0, budget)}\n[…referenced context truncated for length…]`
        : ctx.referencedContext;
    agentPrompt = `<referenced-context>\n${injected}\n</referenced-context>\n\n${agentPrompt}`;
  }

  // A forked transcript keeps its tail — the most recent turns are the most
  // likely to matter to a fresh chat — so earlier turns are dropped first.
  if (ctx.importedContext) {
    const budget = remaining(agentPrompt, maxPrompt);
    const injected =
      ctx.importedContext.length > budget
        ? `[…earlier context truncated for length…]\n${ctx.importedContext.slice(ctx.importedContext.length - budget)}`
        : ctx.importedContext;
    agentPrompt = `<imported-context>\n${injected}\n</imported-context>\n\n${agentPrompt}`;
  }

  // Human discussions are selected only for a discussion-shaped ask. Keep
  // them ahead of ambient repo/fact recall, after explicit conversation sources.
  if (ctx.roomChatContext) {
    const budget = remaining(agentPrompt, maxPrompt);
    if (budget > 0) {
      // Keep complete JSON message records, never a cut-off author/body pair.
      const lines = ctx.roomChatContext.split("\n");
      const kept: string[] = [];
      let length = 0;
      for (const line of lines) {
        if (length + line.length + 1 > budget) break;
        kept.push(line);
        length += line.length + 1;
      }
      if (kept.length > 1) {
        agentPrompt = `<room-chat-context>\n${kept.join("\n")}\n</room-chat-context>\n\n${agentPrompt}`;
      }
    }
  }

  // Repo context is machine-recalled like memory, but more directly actionable
  // for code work, so it takes budget first of the two. Same drop-not-empty rule.
  if (ctx.repoContext) {
    const budget = remaining(agentPrompt, maxPrompt);
    if (budget > 0) {
      const injected =
        ctx.repoContext.length > budget
          ? `${ctx.repoContext.slice(0, budget)}\n[…repo context truncated for length…]`
          : ctx.repoContext;
      agentPrompt = `<repo-context>\n${injected}\n</repo-context>\n\n${agentPrompt}`;
    }
  }

  // Ambient recalled memory sits outermost and takes only leftover budget; if
  // the explicit sources filled it, memory is dropped rather than emitted empty.
  if (ctx.sharedMemory) {
    const budget = remaining(agentPrompt, maxPrompt);
    if (budget > 0) {
      const injected =
        ctx.sharedMemory.length > budget
          ? `${ctx.sharedMemory.slice(0, budget)}\n[…memory truncated for length…]`
          : ctx.sharedMemory;
      agentPrompt = `<memory>\n${injected}\n</memory>\n\n${agentPrompt}`;
    }
  }

  return agentPrompt;
}
