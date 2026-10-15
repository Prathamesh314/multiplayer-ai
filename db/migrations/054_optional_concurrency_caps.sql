-- Concurrency caps become opt-in.
--
-- AI turns on members' own computers are not capped at all (the release
-- before this migration stopped counting them). The caps here now govern only
-- turns executing on this server, and NULL means no cap, as it already did
-- for projects and for the period quotas. New orgs start uncapped.
--
-- Only values still at the old defaults (3 turns, 4 parallel chats) are
-- cleared. There has never been a setting for these, so any other value was
-- chosen by an operator and is kept.
--
-- Deploy only after the previous release, which treats NULL as "no cap": that
-- release is what a rollback lands on. The release before it compared counts
-- against NULL as if it were 0 and would refuse every turn.
ALTER TABLE orgs
  ALTER COLUMN run_concurrency_limit DROP NOT NULL,
  ALTER COLUMN run_concurrency_limit SET DEFAULT NULL,
  ALTER COLUMN parallel_chats_per_user DROP NOT NULL,
  ALTER COLUMN parallel_chats_per_user SET DEFAULT NULL;

UPDATE orgs SET run_concurrency_limit = NULL WHERE run_concurrency_limit = 3;
UPDATE orgs SET parallel_chats_per_user = NULL WHERE parallel_chats_per_user = 4;
