-- A chat's name is drafted from its opening prompt and may be refined once,
-- in the background, right after the chat is created. After that it is the
-- driver's, and nothing automatic may touch it again.
--
-- "Has a human named this?" cannot be inferred from the title itself — a
-- drafted name and a typed name are both just text — so it is recorded.
-- Additive with a default, so the previous release ignores it and rolls back
-- cleanly: it keeps writing titles and simply never reads this column.
ALTER TABLE agent_runs
  ADD COLUMN title_source text NOT NULL DEFAULT 'auto'
    CHECK (title_source IN ('auto', 'manual'));

-- Existing chats were titled from their first prompt by the same rule, so
-- 'auto' is accurate for them. Nothing re-titles an existing chat regardless:
-- refinement only ever runs in the turn that creates the run.
