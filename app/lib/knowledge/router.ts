/*
 * The context router: given a prompt, decide which knowledge sources a run
 * should recall from — the conversation knowledge graph, the indexed repo
 * context, or both — and how widely the graph fan-out should reach.
 *
 * Deterministic on purpose. An LLM classifier here would put a model call on
 * every run's critical path and make retrieval behaviour irreproducible; a
 * signal count is instant, testable, and explainable (the matched signals are
 * returned so a notice or log can say *why* a source was chosen). The rules err
 * toward inclusion: a wrongly included source costs a little prompt budget,
 * a wrongly excluded one loses real context.
 *
 * The three outcomes:
 * - code-shaped prompt, no conversation signals → repo context + the caller's
 *   own room memory only (a project-wide sweep is noise for a mechanical fix,
 *   and skipping it saves up to MAX_BANKS recall calls);
 * - conversation-shaped prompt, no code signals → full-graph memory, no repo
 *   context (file signatures are noise when someone asks what was decided);
 * - mixed or neutral → both, full graph. The safe default.
 */

import type { GraphScope } from "./graph";

export type ContextRoute = {
  /** Recall from the indexed repo-context bank? */
  repo: boolean;
  /** How widely episodic memory fans out over the graph's rooms. */
  graphScope: GraphScope;
  /** The matched signals, for notices/telemetry — the router's "why". */
  signals: { repo: string[]; conversation: string[] };
};

/**
 * Signals a prompt is about the code itself. Each pattern is named so the
 * route can explain itself. Word-boundary keyword lists stay conservative:
 * every entry should read unambiguously as "this is about the codebase".
 */
const REPO_SIGNALS: Array<[name: string, pattern: RegExp]> = [
  // A path-like token: `app/lib/foo.ts`, `db/migrations`, `src/index`.
  ["path", /(?:^|[\s"'`(])[\w.-]+\/[\w./-]+/],
  // A bare filename with a source-ish extension.
  [
    "filename",
    /\b[\w-]+\.(?:tsx?|jsx?|mjs|cjs|py|go|rs|rb|java|kt|swift|c|h|cpp|cs|php|sql|sh|css|scss|html|ya?ml|json|toml|md)\b/i,
  ],
  // Inline code span — the author is already quoting code at us.
  ["code-span", /`[^`]+`/],
  // Verbs/nouns of code work.
  [
    "code-term",
    /\b(?:refactor|implement|debug|compile|typecheck|lint|stack ?trace|type error|unit test|test suite|endpoint|api route|schema|migration|function|class|component|module|import|export|dependency|package|repo|repository|codebase|branch|commit|merge|pull request|bug|fix(?:es|ed|ing)?|crash|error message)\b/i,
  ],
  // camelCase or snake_case identifiers — prose rarely produces either.
  ["identifier", /\b[a-z]+[A-Z][A-Za-z]*\b|\b[a-z]+_[a-z]+\b/],
];

/** Signals a prompt is about what people discussed, decided, or planned. */
const CONVERSATION_SIGNALS: Array<[name: string, pattern: RegExp]> = [
  ["mention", /(?:^|\s)@\w[\w-]*/],
  [
    "discussion-term",
    /\b(?:discussed|discussing|decided|decision|agreed|said|mentioned|talked|conversation|chat(?:s|ted)?|meeting|standup|recap|summar(?:y|ize|ise)|catch (?:me|us) up|what did|who (?:did|was|is)|why did we|last (?:time|week|chat|session)|yesterday|earlier|previously|history|context from|other room|team)\b/i,
  ],
];

function matches(prompt: string, signals: Array<[string, RegExp]>): string[] {
  return signals.filter(([, pattern]) => pattern.test(prompt)).map(([name]) => name);
}

/** Classify one prompt. Pure and total — any string routes somewhere sane. */
export function routeQuery(prompt: string): ContextRoute {
  const repo = matches(prompt, REPO_SIGNALS);
  const conversation = matches(prompt, CONVERSATION_SIGNALS);

  if (repo.length > 0 && conversation.length === 0) {
    return { repo: true, graphScope: "room", signals: { repo, conversation } };
  }
  if (conversation.length > 0 && repo.length === 0) {
    return { repo: false, graphScope: "project", signals: { repo, conversation } };
  }
  return { repo: true, graphScope: "project", signals: { repo, conversation } };
}
