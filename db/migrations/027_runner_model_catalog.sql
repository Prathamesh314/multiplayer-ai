ALTER TABLE runner_devices ADD COLUMN model_catalog jsonb NOT NULL DEFAULT '{}';

CREATE FUNCTION runner_supports_model(catalog jsonb, agent text, model text, effort text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN NOT (catalog ? agent) THEN
    agent IN ('claude', 'codex', 'gemini') AND coalesce(model, '') = ''
      AND (coalesce(effort, '') = '' OR agent = 'codex' AND effort IN ('low', 'medium', 'high'))
  ELSE EXISTS (
    SELECT 1 FROM jsonb_array_elements(catalog->agent->'choices') choice
    WHERE choice->>'id' = coalesce(model, '')
      AND (coalesce(effort, '') = '' OR coalesce(choice->'efforts', '[]') @> jsonb_build_array(jsonb_build_object('id', effort)))
  ) END
$$;
