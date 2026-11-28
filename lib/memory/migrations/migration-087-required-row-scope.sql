-- 역할별 설정 app.require_row_scope=on에서 키나 명시적 주체 없는 거래를 차단한다.
SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE FUNCTION agent_memory.row_scope_matches(target_key text)
RETURNS boolean LANGUAGE sql STABLE
SET search_path = pg_catalog
AS $$
  SELECT CASE
    WHEN current_setting('app.require_row_scope', true) IS DISTINCT FROM 'on' THEN true
    WHEN current_setting('app.row_scope_kind', true) IN ('service', 'master') THEN true
    WHEN current_setting('app.row_scope_kind', true) = 'global' THEN target_key IS NULL
    WHEN current_setting('app.row_scope_kind', true) = 'key' THEN COALESCE(
      target_key = NULLIF(current_setting('app.current_key_id', true), '')
      OR target_key = NULLIF(current_setting('app.row_scope_key', true), '')
      OR target_key = ANY(string_to_array(NULLIF(current_setting('app.current_key_ids', true), ''), ',')),
      false
    )
    ELSE false
  END
$$;

DROP POLICY IF EXISTS required_row_scope ON agent_memory.fragments;
CREATE POLICY required_row_scope ON agent_memory.fragments AS RESTRICTIVE
  USING (agent_memory.row_scope_matches(key_id))
  WITH CHECK (agent_memory.row_scope_matches(key_id));

DROP POLICY IF EXISTS required_row_scope ON agent_memory.fragment_digest;
CREATE POLICY required_row_scope ON agent_memory.fragment_digest AS RESTRICTIVE
  USING (agent_memory.row_scope_matches(key_id))
  WITH CHECK (agent_memory.row_scope_matches(key_id));

DROP POLICY IF EXISTS required_row_scope ON agent_memory.fragment_lineage;
CREATE POLICY required_row_scope ON agent_memory.fragment_lineage AS RESTRICTIVE
  USING (
    current_setting('app.require_row_scope', true) IS DISTINCT FROM 'on'
    OR current_setting('app.row_scope_kind', true) IN ('service', 'master')
    OR EXISTS (SELECT 1 FROM agent_memory.fragments f WHERE f.id = fragment_lineage.child_id)
  );

DROP POLICY IF EXISTS required_row_scope ON agent_memory.fragment_segment;
CREATE POLICY required_row_scope ON agent_memory.fragment_segment AS RESTRICTIVE
  USING (
    current_setting('app.require_row_scope', true) IS DISTINCT FROM 'on'
    OR EXISTS (SELECT 1 FROM agent_memory.fragments f WHERE f.id = fragment_segment.fragment_id)
  );

DROP POLICY IF EXISTS required_row_scope ON agent_memory.fragment_synthetic_query;
CREATE POLICY required_row_scope ON agent_memory.fragment_synthetic_query AS RESTRICTIVE
  USING (agent_memory.row_scope_matches(key_id))
  WITH CHECK (agent_memory.row_scope_matches(key_id));

DROP POLICY IF EXISTS required_row_scope ON agent_memory.fragment_use_events;
CREATE POLICY required_row_scope ON agent_memory.fragment_use_events AS RESTRICTIVE
  USING (agent_memory.row_scope_matches(key_id))
  WITH CHECK (agent_memory.row_scope_matches(key_id));

DROP POLICY IF EXISTS required_row_scope ON agent_memory.idempotency_records;
CREATE POLICY required_row_scope ON agent_memory.idempotency_records AS RESTRICTIVE
  USING (agent_memory.row_scope_matches(key_id))
  WITH CHECK (agent_memory.row_scope_matches(key_id));

DROP POLICY IF EXISTS required_row_scope ON agent_memory.lesson_outcomes;
CREATE POLICY required_row_scope ON agent_memory.lesson_outcomes AS RESTRICTIVE
  USING (agent_memory.row_scope_matches(key_id))
  WITH CHECK (agent_memory.row_scope_matches(key_id));

DROP POLICY IF EXISTS required_row_scope ON agent_memory.tool_feedback_fragments;
CREATE POLICY required_row_scope ON agent_memory.tool_feedback_fragments AS RESTRICTIVE
  USING (agent_memory.row_scope_matches(key_id))
  WITH CHECK (agent_memory.row_scope_matches(key_id));

DROP POLICY IF EXISTS required_row_scope ON agent_memory.fragment_links;
CREATE POLICY required_row_scope ON agent_memory.fragment_links AS RESTRICTIVE
  USING (
    current_setting('app.require_row_scope', true) IS DISTINCT FROM 'on'
    OR current_setting('app.row_scope_kind', true) IN ('service', 'master')
    OR (current_setting('app.row_scope_kind', true) IN ('key', 'global')
        AND EXISTS (SELECT 1 FROM agent_memory.fragments f WHERE f.id = fragment_links.from_id)
        AND EXISTS (SELECT 1 FROM agent_memory.fragments f WHERE f.id = fragment_links.to_id))
  );
