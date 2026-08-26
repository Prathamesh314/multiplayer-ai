/*
 * Access moved up a level: you are added to a *project*, and that grants every
 * room inside it. The per-room roster (session_members) stays only for personal
 * sessions with no project; for org projects, this table is the authority.
 *
 * A project is what a GitHub repo connects to, so the connection details live
 * here too — the rooms under a project are branches of the same repo.
 */

ALTER TABLE projects
  -- Where the repo came from. 'local' keeps the folder-upload path working.
  ADD COLUMN source         text NOT NULL DEFAULT 'local'
                            CHECK (source IN ('github', 'local')),
  -- "owner/name" on GitHub. Null until connected, required once source='github'.
  ADD COLUMN github_repo    text,
  -- The branch rooms fork from. Null for a local import with nothing chosen yet.
  ADD COLUMN default_branch text;

ALTER TABLE projects
  ADD CONSTRAINT projects_github_needs_repo CHECK (
    source <> 'github' OR github_repo IS NOT NULL
  );

/*
 * The access gate. Mirrors team_members: two composite foreign keys make
 * cross-tenant membership unrepresentable — a row must agree with the project
 * on which org it belongs to, AND name someone already in that org. Removing a
 * person from the org removes them from every project in it, atomically.
 */
CREATE TABLE project_members (
  project_id uuid NOT NULL,
  org_id     uuid NOT NULL,
  user_id    uuid NOT NULL,
  role       text NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
  added_by   uuid REFERENCES users(id),
  joined_at  timestamptz NOT NULL DEFAULT now(),
  -- Revokes access without erasing that they were ever on it.
  removed_at timestamptz,

  PRIMARY KEY (project_id, user_id),
  FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, user_id)    REFERENCES org_members (org_id, user_id) ON DELETE CASCADE
);

CREATE INDEX project_members_user_idx
  ON project_members (user_id) WHERE removed_at IS NULL;
