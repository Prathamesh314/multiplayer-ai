-- The AI setup step belongs after the first sign-in, not on the sign-up form.
-- It cannot be inferred from the row insert: the desktop app provisions its
-- account in a browser tab and then finishes sign-in in the app, so "already
-- seen it" has to outlive that handoff.
-- Additive and nullable, so the previous release ignores it and rolls back cleanly.
ALTER TABLE users ADD COLUMN onboarded_at timestamptz;

-- This is a sign-up step. Accounts that already exist have been through sign-up,
-- so they are backfilled rather than shown it on their next sign-in.
UPDATE users SET onboarded_at=now();
