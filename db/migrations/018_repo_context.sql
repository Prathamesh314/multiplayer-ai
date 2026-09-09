/*
 * Repo-context index tracking.
 *
 * The knowledge layer distills a project's canonical `main` into vector
 * memories, stored in a per-SHA bank in the mnemosyne sidecar
 * (`repo:<projectId>:<sha12>` — see app/lib/knowledge/repo-context.ts). This
 * table records which HEAD each project has indexed, and is both the pointer
 * retrieval reads (query the indexed SHA's bank, never a half-built newer one)
 * and the claim that stops concurrent indexers from doing the same work twice:
 * an upsert that only returns a row when the SHA actually changed.
 *
 * Only the pointer lives here — the vectors themselves are in the sidecar,
 * consistent with "optional infrastructure fails open": no sidecar, no rows,
 * no repo context, and runs proceed unchanged.
 */

CREATE TABLE repo_context_index (
  project_id uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  -- The `main` HEAD the current repo bank was built from.
  head_sha   text NOT NULL,
  indexed_at timestamptz NOT NULL DEFAULT now()
);
