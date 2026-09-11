/*
 * Team chat: org-scoped channels (group conversations) and direct messages.
 *
 * A sibling to session_messages (007). That table is the record of a
 * conversation about one room's code; this is the standing team chat that sits
 * above any single room — channels everyone in the org can read, private
 * channels for a subset, and one-to-one DMs between two members.
 *
 * Delivery rides the same event bus used for session chat; these tables are the
 * durable history, not the transport.
 */

CREATE TABLE conversations (
  id          uuid PRIMARY KEY DEFAULT new_id(),
  org_id      uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('channel', 'dm')),
  -- Channels carry a name; a DM is named from its two members at read time.
  name        text,
  topic       text,
  -- A public channel is readable by every active org member; a private one only
  -- by its explicit membership. DMs are always private to their two members.
  visibility  text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'private')),
  -- For a DM, the two user ids sorted and joined ("<uuidA>:<uuidB>"), so the
  -- same pair can never open two DMs. Null for channels.
  dm_key      text,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_message_at timestamptz,
  archived_at timestamptz,
  deleted_at  timestamptz,

  -- Lets membership carry org_id and point back with a composite FK, so a
  -- membership referencing a conversation in another org is unrepresentable.
  UNIQUE (id, org_id),

  CONSTRAINT conversations_channel_named
    CHECK (kind <> 'channel' OR (name IS NOT NULL AND length(btrim(name)) > 0)),
  CONSTRAINT conversations_dm_shape
    CHECK (kind <> 'dm' OR (dm_key IS NOT NULL AND visibility = 'private'))
);

-- One DM per ordered pair per org; partial so a soft-deleted one could be remade.
CREATE UNIQUE INDEX conversations_dm_key_idx
  ON conversations (org_id, dm_key)
  WHERE kind = 'dm' AND deleted_at IS NULL;

CREATE INDEX conversations_org_idx
  ON conversations (org_id)
  WHERE deleted_at IS NULL;

CREATE TABLE conversation_members (
  conversation_id uuid NOT NULL,
  org_id          uuid NOT NULL,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            text NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  added_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  joined_at       timestamptz NOT NULL DEFAULT now(),
  -- When this member last opened the conversation, for unread counts.
  last_read_at    timestamptz NOT NULL DEFAULT now(),
  removed_at      timestamptz,

  PRIMARY KEY (conversation_id, user_id),
  FOREIGN KEY (conversation_id, org_id)
    REFERENCES conversations (id, org_id) ON DELETE CASCADE,
  -- Leaving the org removes the person from every conversation in it.
  FOREIGN KEY (org_id, user_id)
    REFERENCES org_members (org_id, user_id) ON DELETE CASCADE
);

CREATE INDEX conversation_members_user_idx
  ON conversation_members (user_id)
  WHERE removed_at IS NULL;

CREATE TABLE chat_messages (
  id              uuid PRIMARY KEY DEFAULT new_id(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  -- Kept when the account is deleted, like session_messages: a thread does not
  -- lose half its turns because a person left.
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  body            text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  edited_at       timestamptz,
  deleted_at      timestamptz,

  CONSTRAINT chat_messages_body_present CHECK (length(btrim(body)) > 0),
  CONSTRAINT chat_messages_body_length CHECK (length(body) <= 4000)
);

/*
 * Read newest-first and almost never in full, like session chat, so the index
 * is ordered to serve both "the last 50" and "the 50 before that" without a
 * sort.
 */
CREATE INDEX chat_messages_recent_idx
  ON chat_messages (conversation_id, created_at DESC, id DESC)
  WHERE deleted_at IS NULL;
