/*
 * A session is one branch of work; a project is the repo several sessions
 * share. Without the middle layer, "who else is working on this project" can
 * only ever mean "who else is in this session".
 */
CREATE TABLE projects (
  id           uuid PRIMARY KEY DEFAULT new_id(),
  org_id       uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  team_id      uuid,
  slug         citext NOT NULL,
  name         text NOT NULL,
  -- Null for folders opened with no remote, which is most of them.
  upstream_url text,
  created_by   uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  archived_at  timestamptz,

  UNIQUE (org_id, slug),
  UNIQUE (id, org_id),
  FOREIGN KEY (team_id, org_id) REFERENCES teams (id, org_id) ON DELETE SET NULL
);

CREATE INDEX projects_org_id_idx ON projects (org_id);

CREATE TABLE sessions (
  id             text PRIMARY KEY,
  -- Now mandatory. This is the column that ends anonymous sessions.
  owner_id       uuid NOT NULL REFERENCES users(id),
  -- Null means a personal session that belongs to no org.
  org_id         uuid REFERENCES orgs(id) ON DELETE CASCADE,
  project_id     uuid,
  name           text NOT NULL,
  root_name      text,
  -- Still backs the share link, but it now grants a session_members row
  -- instead of an anonymous cookie.
  join_code      text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_active_at timestamptz NOT NULL DEFAULT now(),
  pinned         boolean NOT NULL DEFAULT false,
  archived_at    timestamptz,
  deleted_at     timestamptz,

  CONSTRAINT sessions_id_format CHECK (id ~ '^[a-z2-9]{12}$'),
  CONSTRAINT sessions_join_code_format CHECK (join_code ~ '^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$'),
  -- MATCH SIMPLE: not enforced while project_id is null, which is exactly what
  -- a personal session with no project needs.
  FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON DELETE SET NULL
);

CREATE INDEX sessions_owner_id_idx ON sessions (owner_id);
CREATE INDEX sessions_org_recent_idx ON sessions (org_id, last_active_at DESC);
CREATE INDEX sessions_project_idx ON sessions (project_id) WHERE deleted_at IS NULL;
-- Retention sweep: partial, because pinned rows are never candidates.
CREATE INDEX sessions_reapable_idx ON sessions (last_active_at)
  WHERE pinned = false AND deleted_at IS NULL;

/*
 * One row per seeded session. Separate from `sessions` because it does not
 * exist until a folder has been committed — mirroring `repo: SessionRepo|null`
 * in the application.
 */
CREATE TABLE session_repos (
  session_id             text PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  root_name              text NOT NULL,
  base_branch            text NOT NULL,
  base_sha_at_fork       text NOT NULL,
  session_branch         text NOT NULL,
  head_sha               text NOT NULL,
  dep_lockfile_hash      text,
  spec_doc_sha           text,
  container_image_digest text,
  upstream_url           text,
  last_test_status       text NOT NULL DEFAULT 'unknown'
                         CHECK (last_test_status IN ('pass', 'fail', 'unknown')),
  last_test_sha          text,
  seeded_at              timestamptz NOT NULL DEFAULT now()
);

/*
 * The durable roster: who may open this session. Distinct from presence, which
 * is ephemeral and lives in Redis. This table is the authority on *may*;
 * presence is only the authority on *is here*.
 */
CREATE TABLE session_members (
  session_id   text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         text NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  -- Distinguishes a deliberate invite from a link redemption.
  added_via    text NOT NULL CHECK (added_via IN ('owner', 'share_link', 'org')),
  added_by     uuid REFERENCES users(id),
  joined_at    timestamptz NOT NULL DEFAULT now(),
  -- Coarse and durable: "active 2 days ago" when nobody is online. Not presence.
  last_seen_at timestamptz,
  -- Revokes access without erasing that they were ever here.
  removed_at   timestamptz,

  PRIMARY KEY (session_id, user_id)
);

CREATE INDEX session_members_user_idx
  ON session_members (user_id) WHERE removed_at IS NULL;
