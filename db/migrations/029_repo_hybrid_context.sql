CREATE EXTENSION IF NOT EXISTS vector;

-- Old summary banks are rebuilt on the next approved indexing request.
ALTER TABLE repo_context_index ADD COLUMN index_version integer NOT NULL DEFAULT 0;
ALTER TABLE repo_context_index ADD COLUMN skipped_files integer NOT NULL DEFAULT 0;

CREATE TABLE repo_context_chunks (
  repo_ref text NOT NULL REFERENCES repo_context_index(repo_ref) ON DELETE CASCADE,
  chunk_id text NOT NULL,
  chunk_index integer NOT NULL,
  path text NOT NULL,
  start_line integer NOT NULL CHECK (start_line > 0),
  end_line integer NOT NULL CHECK (end_line >= start_line),
  symbol_name text NOT NULL,
  content text NOT NULL,
  search_text text NOT NULL,
  search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple', search_text)) STORED,
  embedding vector,
  embedding_key text,
  PRIMARY KEY (repo_ref, path, chunk_index),
  CHECK ((embedding IS NULL) = (embedding_key IS NULL))
);
CREATE INDEX repo_context_chunks_fts ON repo_context_chunks USING gin(search_vector);
CREATE INDEX repo_context_chunks_symbol ON repo_context_chunks(repo_ref, symbol_name);
CREATE INDEX repo_context_chunks_identity ON repo_context_chunks(repo_ref, chunk_id);

CREATE TABLE repo_context_skipped_files (
  repo_ref text NOT NULL REFERENCES repo_context_index(repo_ref) ON DELETE CASCADE,
  path text NOT NULL,
  PRIMARY KEY (repo_ref, path)
);

-- Durable requests contain an approved SHA, never a moving branch name.
-- Workers claim rows with SKIP LOCKED; rollback leaves the request retryable.
CREATE TABLE repo_context_jobs (
  repo_ref text PRIMARY KEY,
  head_sha text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  retry_at timestamptz NOT NULL DEFAULT now(),
  last_error text
);

-- Preserve the approval boundary when upgrading existing repositories.
INSERT INTO repo_context_jobs(repo_ref, head_sha)
SELECT repo_ref, head_sha FROM repo_context_index;
