-- migration-025-case-id-episode.sql
-- case_id 추가 + episode 파편 스키마 확장 + assertion_status
-- 작성자: 최진호
-- 작성일: 2026-04-03


ALTER TABLE agent_memory.fragments
    ADD COLUMN IF NOT EXISTS case_id VARCHAR(255) DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_frag_case_id
    ON agent_memory.fragments (case_id)
    WHERE case_id IS NOT NULL;

ALTER TABLE agent_memory.fragments
    ADD COLUMN IF NOT EXISTS goal               TEXT DEFAULT NULL;

ALTER TABLE agent_memory.fragments
    ADD COLUMN IF NOT EXISTS outcome            TEXT DEFAULT NULL;

ALTER TABLE agent_memory.fragments
    ADD COLUMN IF NOT EXISTS phase              VARCHAR(50) DEFAULT NULL;

ALTER TABLE agent_memory.fragments
    ADD COLUMN IF NOT EXISTS resolution_status  TEXT DEFAULT NULL
    CHECK (resolution_status IS NULL OR
           resolution_status IN ('open', 'resolved', 'abandoned'));

ALTER TABLE agent_memory.fragments
    ADD COLUMN IF NOT EXISTS assertion_status   TEXT DEFAULT 'observed'
    CHECK (assertion_status IN ('observed', 'inferred', 'verified', 'rejected'));

CREATE INDEX IF NOT EXISTS idx_frag_case_created
    ON agent_memory.fragments (case_id, created_at DESC)
    WHERE case_id IS NOT NULL AND valid_to IS NULL;

CREATE INDEX IF NOT EXISTS idx_frag_assertion_status
    ON agent_memory.fragments (assertion_status)
    WHERE assertion_status IS NOT NULL;

