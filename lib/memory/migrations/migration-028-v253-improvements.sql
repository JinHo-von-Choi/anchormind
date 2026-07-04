-- migration-028-v253-improvements.sql
-- v2.5.3 스키마 개선: 복합 인덱스 추가, 잔여 데이터 정리, dead 컬럼 제거
-- 작성자: 최진호
-- 작성일: 2026-04-06

-- ─────────────────────────────────────────────
-- 1. (agent_id, topic, created_at DESC) 복합 인덱스
--    migration-016의 idx_frag_agent_topic을 완전 포함하므로 교체
-- ─────────────────────────────────────────────
DROP INDEX IF EXISTS agent_memory.idx_frag_agent_topic;

CREATE INDEX IF NOT EXISTS idx_frag_agent_topic_created
  ON agent_memory.fragments (agent_id, topic, created_at DESC);

-- ─────────────────────────────────────────────
-- 2. (key_id, agent_id, importance DESC) 부분 인덱스
--    valid_to IS NULL 활성 파편 대상, QuotaChecker + 키 격리 조회 커버
-- ─────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_frag_keyid_agent_importance
  ON agent_memory.fragments (key_id, agent_id, importance DESC)
  WHERE valid_to IS NULL;

-- ─────────────────────────────────────────────
-- 3. source='session:unknown' 잔여 파편 정리
-- ─────────────────────────────────────────────
UPDATE agent_memory.fragments
   SET source = NULL
 WHERE source = 'session:unknown';

-- ─────────────────────────────────────────────
-- 4. search_events.rrf_used 중복 컬럼 제거 (used_rrf로 단일화)
-- ─────────────────────────────────────────────
ALTER TABLE agent_memory.search_events DROP COLUMN IF EXISTS rrf_used;

-- ─────────────────────────────────────────────
-- 5. fragments.superseded_by dead 컬럼 제거 (fragment_links로 대체)
-- ─────────────────────────────────────────────
ALTER TABLE agent_memory.fragments DROP COLUMN IF EXISTS superseded_by;

-- ─────────────────────────────────────────────
-- 6. search_events 빈 search_path 백필
-- ─────────────────────────────────────────────
UPDATE agent_memory.search_events SET search_path = 'L2:0' WHERE search_path = '';
