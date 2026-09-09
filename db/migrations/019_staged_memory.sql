/*
 * Approval-gated memory staging.
 *
 * An agent exchange that *changed files* must not become shared knowledge the
 * moment the run finishes — the human hasn't accepted that work yet, and wrong
 * code remembered as fact would poison every room's recall. So such exchanges
 * are staged here (app/lib/ai/shared-memory.ts) and folded into the room's
 * memory bank only when the user approves the code by publishing the room to
 * the project's `main`. Work that never gets published never becomes memory.
 *
 * Pure Q&A exchanges (runs that produced no commit) skip this table — there is
 * no code to approve, so they ingest immediately as before.
 *
 * Rows are deleted as they are ingested; whatever remains is exactly the
 * not-yet-approved backlog. Cascades keep it honest: deleting the run or the
 * room takes its staged (never-approved) exchanges with it.
 */

CREATE TABLE staged_memory_exchanges (
  id         uuid PRIMARY KEY DEFAULT new_id(),
  session_id text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  run_id     uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  prompt     text NOT NULL,
  reply      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Publish drains a room's backlog oldest-first, so the index matches the read.
CREATE INDEX staged_memory_exchanges_session_idx
  ON staged_memory_exchanges (session_id, created_at);
