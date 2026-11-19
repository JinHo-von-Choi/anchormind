-- migration-083-experience-signal.sql
--
-- 작성자: 최진호
-- 작성일: 2026-11-19
--
-- 노출과 사용을 나누고 교훈의 적용 결과를 받는 표.
--   tool_feedback_fragments  tool_feedback 한 건이 지목한 파편과 그 판정. search_event_id가 있으면 그 검색이 돌려준
--                            파편만 받는다. 세션은 검색 이벤트에서 가져온다.
--   fragment_use_events      에이전트가 파편 id를 직접 지목한 사건. 노출(recall 반환, context 주입, 그래프 확산)은
--                            넣지 않는다. 같은 사건은 (kind, source_ref, fragment_id)로 한 번만 센다.
--   lesson_outcomes          reflect lessons_applied로 받은 교훈 적용 결과. 같은 세션의 같은 교훈은 한 번만 센다.
--   memory_daily_metrics     정리 주기가 하루 한 번 쓰는 집계 지표. search_events가 30일 뒤 지워져도 남는다.
-- consolidation_changes.action에 ema_decayed를 더한다. EMA 감쇠 단계가 이전 값을 남겨 주기 되돌리기로 복원한다.
-- fragments 표에는 열을 더하지 않는다. 파편이 지워지면 앞의 세 표의 행도 지운다.
-- 멱등: 표, 색인, 제약, 정책이 이미 있으면 다시 만들지 않는다.

SET LOCAL lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS agent_memory.tool_feedback_fragments (
  feedback_id  BIGINT      NOT NULL,
  fragment_id  TEXT        NOT NULL REFERENCES agent_memory.fragments(id) ON DELETE CASCADE,
  key_id       TEXT,
  relevant     BOOLEAN     NOT NULL,
  session_id   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (feedback_id, fragment_id)
);
CREATE INDEX IF NOT EXISTS idx_tool_feedback_fragments_fragment ON agent_memory.tool_feedback_fragments (fragment_id);
CREATE INDEX IF NOT EXISTS idx_tool_feedback_fragments_created  ON agent_memory.tool_feedback_fragments (created_at);

CREATE TABLE IF NOT EXISTS agent_memory.fragment_use_events (
  id           BIGSERIAL   PRIMARY KEY,
  fragment_id  TEXT        NOT NULL REFERENCES agent_memory.fragments(id) ON DELETE CASCADE,
  key_id       TEXT,
  kind         TEXT        NOT NULL CHECK (kind IN ('feedback_relevant', 'verified', 'lesson_applied', 'link_explicit', 'evidence_cited')),
  source_ref   TEXT        NOT NULL CHECK (length(source_ref) BETWEEN 1 AND 200),
  session_id   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (kind, source_ref, fragment_id)
);
CREATE INDEX IF NOT EXISTS idx_fragment_use_events_fragment ON agent_memory.fragment_use_events (fragment_id, created_at);
CREATE INDEX IF NOT EXISTS idx_fragment_use_events_created  ON agent_memory.fragment_use_events (created_at);

CREATE TABLE IF NOT EXISTS agent_memory.lesson_outcomes (
  id           BIGSERIAL   PRIMARY KEY,
  lesson_id    TEXT        NOT NULL REFERENCES agent_memory.fragments(id) ON DELETE CASCADE,
  key_id       TEXT,
  session_id   TEXT        NOT NULL CHECK (length(session_id) BETWEEN 1 AND 200),
  outcome      TEXT        NOT NULL CHECK (outcome IN ('helped', 'failed', 'not_applicable')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (lesson_id, session_id)
);
CREATE INDEX IF NOT EXISTS idx_lesson_outcomes_created ON agent_memory.lesson_outcomes (created_at);

CREATE TABLE IF NOT EXISTS agent_memory.memory_daily_metrics (
  day          DATE        NOT NULL,
  key_id       TEXT        NOT NULL DEFAULT '',
  metric       TEXT        NOT NULL CHECK (length(metric) BETWEEN 1 AND 64),
  value        DOUBLE PRECISION,
  numerator    BIGINT,
  denominator  BIGINT,
  detail       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  computed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (day, key_id, metric)
);

-- 키 축 격리. fragments 정책(migration-080)과 같은 설정을 읽는다. 표 소유자에게는 FORCE 전까지 적용되지 않는다.
DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['tool_feedback_fragments', 'fragment_use_events', 'lesson_outcomes'] LOOP
    EXECUTE format('ALTER TABLE agent_memory.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON agent_memory.%I', t || '_isolation_policy', t);
    EXECUTE format($p$
      CREATE POLICY %I ON agent_memory.%I
        USING (
          current_setting('app.current_agent_id', true) IN ('system', 'admin')
          OR (COALESCE(current_setting('app.current_key_id', true), '') = ''
              AND COALESCE(current_setting('app.current_key_ids', true), '') = '')
          OR key_id = NULLIF(current_setting('app.current_key_id', true), '')
          OR key_id = ANY(string_to_array(NULLIF(current_setting('app.current_key_ids', true), ''), ','))
        )
        WITH CHECK (
          current_setting('app.current_agent_id', true) IN ('system', 'admin')
          OR (COALESCE(current_setting('app.current_key_id', true), '') = ''
              AND COALESCE(current_setting('app.current_key_ids', true), '') = '')
          OR key_id = NULLIF(current_setting('app.current_key_id', true), '')
          OR key_id = ANY(string_to_array(NULLIF(current_setting('app.current_key_ids', true), ''), ','))
        )$p$, t || '_isolation_policy', t);
  END LOOP;
END $$;

ALTER TABLE agent_memory.consolidation_changes DROP CONSTRAINT IF EXISTS consolidation_changes_action_check;
ALTER TABLE agent_memory.consolidation_changes
  ADD CONSTRAINT consolidation_changes_action_check
  CHECK (action IN ('closed', 'created', 'anchored', 'ema_decayed'));
