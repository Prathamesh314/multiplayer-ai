/*
 * Full-text search over agent-run conversations.
 *
 * The "@room/chat" reference feature pulls the most relevant conversations of a
 * referenced chat, ranked against the asker's prompt. That ranking is a
 * to_tsvector/websearch_to_tsquery match on the message body; this GIN index
 * makes it scale past a handful of messages per run.
 *
 * The two-argument to_tsvector(regconfig, text) form is IMMUTABLE (the config
 * is a constant here), which is what lets it back an expression index.
 */
CREATE INDEX agent_run_messages_body_fts_idx
  ON agent_run_messages
  USING gin (to_tsvector('english', body));
