/*
 * One room per member per project.
 *
 * A project room stops being something you open ad hoc: every project member
 * gets exactly one, created for them and named after their handle (they can
 * rename it later). The invariant lives here as a partial unique index so no
 * code path — API, worker, backfill — can hand someone a second room.
 *
 * Existing extras are detached into personal rooms rather than deleted: the
 * work in them is still real, it just no longer hangs off the project. The
 * survivor per (project, owner) is the most recently active room. Member
 * rooms are also pinned, because the retention sweep must not reap the only
 * room a member has in a project just because they went on holiday.
 */

WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY project_id, owner_id
           ORDER BY last_active_at DESC, created_at DESC, id
         ) AS keep_rank
    FROM sessions
   WHERE project_id IS NOT NULL AND deleted_at IS NULL
)
UPDATE sessions s
   SET project_id = NULL, org_id = NULL
  FROM ranked r
 WHERE s.id = r.id AND r.keep_rank > 1;

UPDATE sessions
   SET pinned = TRUE
 WHERE project_id IS NOT NULL AND deleted_at IS NULL;

CREATE UNIQUE INDEX sessions_member_room_key
  ON sessions (project_id, owner_id)
  WHERE project_id IS NOT NULL AND deleted_at IS NULL;
