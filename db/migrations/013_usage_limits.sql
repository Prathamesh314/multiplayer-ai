/*
 * Cost controls for AI runs.
 *
 * Every run spawns a coding agent — real compute, not a moved pixel — so 20
 * people jumping between rooms and all triggering agents at once is a bill and a
 * rate-limit wall. Limits live where the money does: pooled at the org, with a
 * tighter throttle available per project.
 *
 * Defaults keep concurrency bounded (the main compute lever) while leaving the
 * period/rate caps opt-in, so existing orgs are governed but not surprised.
 */

ALTER TABLE orgs
  -- Most agents that may run at the same time across the whole org.
  ADD COLUMN run_concurrency_limit int NOT NULL DEFAULT 3
    CHECK (run_concurrency_limit >= 0),
  -- Runs allowed per calendar month. NULL means unlimited.
  ADD COLUMN run_monthly_quota int
    CHECK (run_monthly_quota IS NULL OR run_monthly_quota >= 0);

ALTER TABLE projects
  -- Tighter concurrent cap for one project. NULL inherits the org's limit.
  ADD COLUMN run_concurrency_limit int
    CHECK (run_concurrency_limit IS NULL OR run_concurrency_limit >= 0),
  -- Runs allowed per rolling hour in this project. NULL means unlimited.
  ADD COLUMN run_hourly_limit int
    CHECK (run_hourly_limit IS NULL OR run_hourly_limit >= 0);

-- Concurrency and rate checks count recent runs by (org/project, status, time),
-- so index the join column the counts start from.
CREATE INDEX agent_runs_started_at_idx ON agent_runs (started_at)
  WHERE status = 'running';
