-- Who someone is, how they prove it, and how they get added to an org.

CREATE TABLE users (
  id                      uuid PRIMARY KEY DEFAULT new_id(),
  handle                  citext NOT NULL UNIQUE,
  email                   citext NOT NULL UNIQUE,
  email_verified_at       timestamptz,
  display_name            text NOT NULL,
  avatar_url              text,
  -- Null for accounts that only ever sign in through a provider.
  password_hash           text,
  -- The "paste this to add me" string. Rotatable, so a leaked code is
  -- revocable without touching the account.
  connect_code            text NOT NULL UNIQUE,
  connect_code_rotated_at timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  -- Soft delete: sessions and commits reference this row forever.
  deleted_at              timestamptz,

  -- Cast to text first. Comparing citext with a regex is case-insensitive,
  -- which would let "Prathamesh" satisfy a lowercase-only pattern.
  CONSTRAINT users_handle_format
    CHECK (handle::text ~ '^[a-z0-9][a-z0-9_-]{1,38}$'),
  CONSTRAINT users_connect_code_format
    CHECK (connect_code ~ '^PK-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$'),
  CONSTRAINT users_display_name_present
    CHECK (length(btrim(display_name)) > 0)
);

CREATE TRIGGER users_touch_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE user_identities (
  id               uuid PRIMARY KEY DEFAULT new_id(),
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider         text NOT NULL CHECK (provider IN ('github', 'google')),
  -- The provider's immutable numeric id, never the username: usernames change
  -- and get recycled.
  provider_user_id text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),

  UNIQUE (provider, provider_user_id)
);

CREATE INDEX user_identities_user_id_idx ON user_identities (user_id);

/*
 * Login state. Deliberately not called "sessions" — that name already means a
 * workspace in this product, and the URL /s/<id> makes it permanent.
 */
CREATE TABLE auth_tokens (
  id           uuid PRIMARY KEY DEFAULT new_id(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- SHA-256 of the cookie value. A database leak must not be a login leak.
  token_hash   bytea NOT NULL UNIQUE,
  issued_at    timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  last_used_at timestamptz,
  user_agent   text,
  ip           inet,

  CONSTRAINT auth_tokens_expiry_after_issue CHECK (expires_at > issued_at)
);

CREATE INDEX auth_tokens_live_idx
  ON auth_tokens (user_id) WHERE revoked_at IS NULL;
