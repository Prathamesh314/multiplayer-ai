-- Line counts of a run's diff (base → result), for the sidebar's +N -N badges.
-- Null until a run finishes (and only when it produced a commit).
ALTER TABLE agent_runs
  ADD COLUMN added_lines   integer,
  ADD COLUMN removed_lines integer;
