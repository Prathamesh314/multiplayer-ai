/*
 * Multiple repos per room.
 *
 * A room is born bound to one repo — its fork of the project's canonical
 * `main` (session_repos, 1:1 by design). But a member's room is their
 * workspace, not just a project checkout: they should be able to pull any
 * other codebase into it and chat with agents about that too. This table
 * holds those *additional* repos.
 *
 * The design leans on the existing invariant that a bare repo lives at
 * `repos/<id>.git` for whatever id owns it: room repos mint ids from the same
 * alphabet as sessions, so every path helper, lock, seed, and commit routine
 * works on them unchanged. The room's own project fork stays in session_repos
 * untouched — an agent run with `repo_id IS NULL` targets it, exactly as
 * before, so nothing existing migrates.
 *
 * Imported repos are standalone: they have no project remote, so publish/sync
 * never touch them. Their changes live in their own history until (a future)
 * export path exists.
 */

CREATE TABLE room_repos (
  -- Same alphabet as session ids so repos/<id>.git and work/<id> just work.
  id           text PRIMARY KEY CHECK (id ~ '^[a-z2-9]{12}$'),
  session_id   text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  -- Display name: the imported folder's root, unique within the room so the
  -- picker and the grouped chat list never show two identical labels.
  root_name    text NOT NULL,
  head_sha     text,
  upstream_url text,
  -- Who imported it. RESTRICT, matching authorship rows elsewhere.
  created_by   uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- Set when the upload finished and the first commit exists; a null means a
  -- half-finished import that must not accept runs yet.
  seeded_at    timestamptz,

  CONSTRAINT room_repos_name_length CHECK (length(root_name) BETWEEN 1 AND 100),
  UNIQUE (session_id, root_name)
);

CREATE INDEX room_repos_session_idx ON room_repos (session_id, created_at);

-- Which repo a chat works on. Null = the room's project fork (every existing
-- run, and the default for new ones). SET NULL keeps the conversation history
-- readable even if its repo is ever removed.
ALTER TABLE agent_runs
  ADD COLUMN repo_id text REFERENCES room_repos(id) ON DELETE SET NULL;

-- The grouped chat list reads a room's runs per repo.
CREATE INDEX agent_runs_repo_idx ON agent_runs (session_id, repo_id, created_at DESC);
