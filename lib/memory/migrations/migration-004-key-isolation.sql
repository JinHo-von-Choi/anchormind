-- Migration 004: API 키 기반 기억 격리
-- 작성자: 최진호 / 2026-03-03
--
-- 격리 모델:
--   key_id IS NULL  → 마스터 키(MEMENTO_ACCESS_KEY)로 저장된 기억 (마스터만 조회 가능)
--   key_id = 'xxx'  → 해당 API 키로 저장된 기억 (그 키만 조회 가능)


ALTER TABLE agent_memory.fragments
    ADD COLUMN IF NOT EXISTS key_id TEXT
        REFERENCES agent_memory.api_keys(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_frag_key_id
    ON agent_memory.fragments(key_id)
    WHERE key_id IS NOT NULL;

