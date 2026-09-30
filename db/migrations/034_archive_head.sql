-- A bare archive must retain its default branch or detached HEAD, not assume main.
-- Null in both columns identifies archives created before this metadata existed.
ALTER TABLE git_archives ADD COLUMN head_ref text;
ALTER TABLE git_archives ADD COLUMN head_sha text;
