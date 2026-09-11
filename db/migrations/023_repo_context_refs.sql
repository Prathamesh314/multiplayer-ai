/*
 * Repo context, per repo — not just per project.
 *
 * The AI must understand the code it is about to change, and the code a chat
 * changes is rarely the project's canonical `main`: it is the room's fork, or
 * an imported repo, each with its own history. So the indexed-context pointer
 * is re-keyed from project_id to a generic `repo_ref` — a project id (its
 * canonical main), a session id (the room's fork), or a room_repos id (an
 * import). Same claim semantics as before: the upsert returns a row only when
 * the SHA actually changed, so racing indexers distill once.
 *
 * When each ref updates is the approval contract, enforced in code:
 *  - project main    → on publish (the approval event), as before;
 *  - room fork       → on publish too — unapproved work stays out of context;
 *  - imported repo / personal room → at run completion, which is the only
 *    "approved" there is where no publish flow exists (mirrors the shared-
 *    memory gating rule exactly).
 *
 * No FK: the refs are heterogeneous. A pointer row orphaned by its repo's
 * deletion is one dead row pointing at a bank nothing will ever query — inert
 * by the same argument as superseded per-SHA banks.
 */

DROP TABLE repo_context_index;

CREATE TABLE repo_context_index (
  repo_ref   text PRIMARY KEY,
  head_sha   text NOT NULL,
  indexed_at timestamptz NOT NULL DEFAULT now()
);
