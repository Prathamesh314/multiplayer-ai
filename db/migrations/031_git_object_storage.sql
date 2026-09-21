-- Immutable bundle bytes live in object storage. Mutable refs, generations,
-- and fencing tokens are published atomically here, after durable upload.
CREATE TABLE git_repositories (
  repo_key text PRIMARY KEY CHECK (repo_key ~ '^(repos|projects)/[a-zA-Z0-9_-]+$'),
  initialized boolean NOT NULL DEFAULT false,
  bundle_key text,
  bundle_sha256 text,
  refs jsonb NOT NULL DEFAULT '{}',
  head text NOT NULL DEFAULT 'refs/heads/main',
  revision bigint NOT NULL DEFAULT 0,
  fence bigint NOT NULL DEFAULT 0,
  lease_token uuid,
  lease_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((bundle_key IS NULL) = (bundle_sha256 IS NULL))
);
CREATE TABLE git_storage_history (
  id uuid PRIMARY KEY DEFAULT new_id(),
  repo_key text NOT NULL REFERENCES git_repositories(repo_key),
  revision bigint NOT NULL,
  bundle_key text,
  bundle_sha256 text,
  refs jsonb NOT NULL,
  head text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(repo_key, revision)
);
CREATE TABLE git_storage_jobs (
  repo_key text PRIMARY KEY,
  attempts integer NOT NULL DEFAULT 0,
  retry_at timestamptz NOT NULL DEFAULT now(),
  last_error text
);
-- Tombstones retain metadata, provenance and code. No inactivity policy is
-- allowed to hard-delete a room. Explicit administrator deletion has a grace.
CREATE TABLE session_deletions (
  session_id text PRIMARY KEY REFERENCES sessions(id),
  requested_by uuid NOT NULL REFERENCES users(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  delete_after timestamptz NOT NULL DEFAULT now() + interval '7 days',
  completed_at timestamptz,
  restored_at timestamptz,
  backup jsonb NOT NULL,
  CHECK (delete_after >= requested_at + interval '7 days')
);
CREATE TABLE session_archives (
  session_id text PRIMARY KEY REFERENCES sessions(id),
  backup jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
