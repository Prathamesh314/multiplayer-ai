-- Provider-neutral, project-scoped source records. Credentials never enter
-- prompts or API responses. Removing a connection/channel removes its context.
CREATE TABLE context_connections (
  id uuid PRIMARY KEY DEFAULT new_id(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('slack','discord')),
  external_id text NOT NULL,
  name text NOT NULL,
  credential text NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, provider)
);
CREATE INDEX context_connections_source ON context_connections(provider, external_id);
CREATE TABLE context_channels (
  connection_id uuid NOT NULL REFERENCES context_connections(id) ON DELETE CASCADE,
  channel_id text NOT NULL,
  name text NOT NULL,
  url text NOT NULL,
  verified_at timestamptz,
  access_version bigint NOT NULL DEFAULT 0,
  stored_messages integer NOT NULL DEFAULT 0 CHECK (stored_messages >= 0),
  synced_at timestamptz,
  next_sync_at timestamptz NOT NULL DEFAULT now(),
  error text,
  PRIMARY KEY (connection_id, channel_id)
);
CREATE INDEX context_channels_sync ON context_channels(next_sync_at);
CREATE TABLE context_sync_budgets (
  provider text NOT NULL,
  external_id text NOT NULL,
  next_request_at timestamptz NOT NULL,
  PRIMARY KEY (provider, external_id)
);
CREATE TABLE context_messages (
  connection_id uuid NOT NULL,
  channel_id text NOT NULL,
  message_id text NOT NULL,
  author_id text NOT NULL,
  author_name text NOT NULL,
  body text NOT NULL CHECK (length(body) <= 16000),
  url text NOT NULL,
  thread_id text,
  sent_at timestamptz NOT NULL,
  source_version numeric NOT NULL,
  deleted boolean NOT NULL DEFAULT false,
  search_document tsvector GENERATED ALWAYS AS (
    to_tsvector('english', body) || to_tsvector('simple', body)
  ) STORED,
  PRIMARY KEY (connection_id, channel_id, message_id),
  FOREIGN KEY (connection_id, channel_id) REFERENCES context_channels(connection_id, channel_id) ON DELETE CASCADE
);
CREATE INDEX context_messages_search ON context_messages USING gin(search_document) WHERE NOT deleted;
CREATE INDEX context_messages_recent ON context_messages(connection_id, channel_id, sent_at DESC);
CREATE INDEX context_messages_expiry ON context_messages(sent_at);
-- Maintain the bounded-record count without scanning a channel's whole history
-- for every event. Updates/tombstones keep their row; inserts/deletes change it.
CREATE FUNCTION context_message_count() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE context_channels SET stored_messages=stored_messages+1
      WHERE connection_id=NEW.connection_id AND channel_id=NEW.channel_id;
  ELSE
    UPDATE context_channels SET stored_messages=stored_messages-1
      WHERE connection_id=OLD.connection_id AND channel_id=OLD.channel_id;
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER context_message_count_changed AFTER INSERT OR DELETE ON context_messages
  FOR EACH ROW EXECUTE FUNCTION context_message_count();
CREATE TABLE context_oauth_states (
  digest bytea PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('slack','discord')),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '10 minutes'
);
