-- Projects organize collaboration; repositories have independent identities.
CREATE TABLE project_repositories (
  id uuid PRIMARY KEY DEFAULT new_id(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  github_repo text,
  upstream_url text,
  default_branch text NOT NULL DEFAULT 'main',
  ready boolean NOT NULL DEFAULT false,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, name)
);

-- Reuse legacy storage keys: no Git histories or files are moved or deleted.
INSERT INTO project_repositories (id, project_id, name, github_repo, upstream_url, default_branch, created_by, created_at, ready)
SELECT p.id, p.id, p.name, p.github_repo, p.upstream_url, COALESCE(p.default_branch, 'main'), p.created_by, p.created_at, true
FROM projects p
WHERE p.github_repo IS NOT NULL OR p.upstream_url IS NOT NULL
   OR EXISTS (SELECT 1 FROM sessions s JOIN session_repos r ON r.session_id = s.id WHERE s.project_id = p.id);

ALTER TABLE session_repos ADD COLUMN project_repository_id uuid REFERENCES project_repositories(id) ON DELETE SET NULL;
ALTER TABLE room_repos ADD COLUMN project_repository_id uuid REFERENCES project_repositories(id) ON DELETE SET NULL;
UPDATE session_repos r SET project_repository_id = s.project_id
FROM sessions s WHERE s.id = r.session_id AND s.project_id IN (SELECT id FROM project_repositories);
CREATE UNIQUE INDEX room_repos_project_repository_key ON room_repos(session_id, project_repository_id);

-- A room may only select repositories from its own project.
CREATE FUNCTION check_room_repository_project() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.project_repository_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM sessions s JOIN project_repositories r ON r.project_id = s.project_id
    WHERE s.id = NEW.session_id AND r.id = NEW.project_repository_id
  ) THEN RAISE EXCEPTION 'Repository belongs to another project' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER session_repo_project_check BEFORE INSERT OR UPDATE ON session_repos
FOR EACH ROW EXECUTE FUNCTION check_room_repository_project();
CREATE TRIGGER room_repo_project_check BEFORE INSERT OR UPDATE ON room_repos
FOR EACH ROW EXECUTE FUNCTION check_room_repository_project();

ALTER TABLE projects DROP COLUMN source, DROP COLUMN github_repo, DROP COLUMN default_branch, DROP COLUMN upstream_url;
