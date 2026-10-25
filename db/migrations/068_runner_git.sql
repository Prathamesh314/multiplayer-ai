-- Git on each connected computer, as its runner reports it: the version, or
-- 'missing' when Git cannot start there (AI tasks then cannot run). NULL until
-- a runner that reports it checks in. Shown in Set up AI and Your computers.
ALTER TABLE runner_devices ADD COLUMN git_version text;
