-- The connecting member's account at the provider (for Discord, their user
-- ID). Channels are offered as that member can see them, by their roles,
-- not only those everyone in the server can read. NULL for connections made
-- before this, which keep offering only public channels until reconnected.
-- Additive and nullable, so the previous release ignores it.
ALTER TABLE context_connections
  ADD COLUMN external_user_id text CHECK (external_user_id IS NULL OR external_user_id ~ '^[0-9]{1,25}$');
