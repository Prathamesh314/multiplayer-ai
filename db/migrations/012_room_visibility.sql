/*
 * Room privacy.
 *
 * Being on a project no longer implies seeing every room in it. A room is
 * either:
 *
 *   public   — anyone on the project can open it (the old behaviour), or
 *   private  — invite-only: access comes solely from session_members, so a
 *              manager can draft a sensitive prompt without their peers, and
 *              only the people they add can see it.
 *
 * Default public, because the common case is shared work and a silent switch
 * to invite-only would strand existing rooms.
 */

ALTER TABLE sessions
  ADD COLUMN visibility text NOT NULL DEFAULT 'public'
                       CHECK (visibility IN ('public', 'private'));

-- Listing a project's rooms filters private ones by roster, so the lookup is
-- "is this user on this private room" — index it.
CREATE INDEX sessions_private_idx
  ON sessions (project_id) WHERE visibility = 'private' AND deleted_at IS NULL;
