-- migration-027-v25: Reconsolidation + Episode Continuity + Spreading Activation
-- v2.5.0 Phase 1~3 마이그레이션 통합 (원래 027~030 개별 파일)
--
-- 포함 내용:
--   1. search_events + case_events key_id 타입 수정 (INTEGER → TEXT)
--   2. fragment_links 재통합 컬럼 + link_reconsolidations 이력 테이블
--   3. case_events idempotency_key + preceded_by 인덱스
--   4. fragments.keywords GIN 인덱스

-- ─────────────────────────────────────────────
-- Part 1: key_id 타입 정합성 수정
-- migration-013(search_events), migration-026(case_events)에서 key_id를
-- INTEGER로 정의했으나 api_keys.id는 TEXT 타입이므로 수정
-- ─────────────────────────────────────────────

ALTER TABLE agent_memory.search_events
  DROP CONSTRAINT IF EXISTS search_events_key_id_fkey;

ALTER TABLE agent_memory.search_events
  ALTER COLUMN key_id TYPE TEXT USING key_id::TEXT;

ALTER TABLE agent_memory.case_events
  ALTER COLUMN key_id TYPE TEXT USING key_id::TEXT;

-- ─────────────────────────────────────────────
-- Part 2: Reconsolidation — fragment_links 확장 + 이력 테이블
-- ─────────────────────────────────────────────

ALTER TABLE agent_memory.fragment_links
  ADD COLUMN IF NOT EXISTS confidence      NUMERIC(4,3) NOT NULL DEFAULT 1.000
    CHECK (confidence >= 0 AND confidence <= 1),
  ADD COLUMN IF NOT EXISTS decay_rate      NUMERIC(6,5) NOT NULL DEFAULT 0.005
    CHECK (decay_rate >= 0 AND decay_rate <= 1),
  ADD COLUMN IF NOT EXISTS deleted_at      TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS delete_reason   TEXT NULL,
  ADD COLUMN IF NOT EXISTS quarantine_state TEXT NULL
    CHECK (quarantine_state IN ('soft', 'released'));

CREATE INDEX IF NOT EXISTS idx_fragment_links_active
  ON agent_memory.fragment_links(from_id, to_id, relation_type)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS agent_memory.link_reconsolidations (
  id             BIGSERIAL PRIMARY KEY,
  link_id        BIGINT NOT NULL REFERENCES agent_memory.fragment_links(id) ON DELETE CASCADE,
  action         TEXT NOT NULL CHECK (action IN ('reinforce','decay','quarantine','restore','soft_delete')),
  old_weight     REAL NOT NULL,
  new_weight     REAL NOT NULL,
  old_confidence NUMERIC(4,3) NOT NULL,
  new_confidence NUMERIC(4,3) NOT NULL,
  reason         TEXT NOT NULL,
  triggered_by   TEXT,
  key_id         TEXT REFERENCES agent_memory.api_keys(id),
  metadata       JSONB NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_link_recon_link_id
  ON agent_memory.link_reconsolidations(link_id, created_at DESC);

-- ─────────────────────────────────────────────
-- Part 3: Episode Continuity — idempotency_key + preceded_by 인덱스
-- ─────────────────────────────────────────────

ALTER TABLE agent_memory.case_events
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_case_events_idempotency
  ON agent_memory.case_events(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_case_event_edges_preceded_by
  ON agent_memory.case_event_edges(from_event_id, to_event_id)
  WHERE edge_type = 'preceded_by';

-- ─────────────────────────────────────────────
-- Part 4: Spreading Activation — keywords GIN 인덱스
-- ─────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_fragments_keywords_gin
  ON agent_memory.fragments USING GIN (keywords)
  WHERE valid_to IS NULL;
