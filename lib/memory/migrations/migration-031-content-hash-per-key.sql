-- migration-031-content-hash-per-key.sql
-- 작성자: 최진호
-- 작성일: 2026-04-10
-- 목적: content_hash 전역 UNIQUE 인덱스(idx_frag_hash)를 drop하고
--       partial unique index 2개로 전환하여 크로스 테넌트 ON CONFLICT 경로 차단.
--
--   uq_frag_hash_master   : master(key_id IS NULL) 전용 unique
--   uq_frag_hash_per_key  : DB API key(key_id IS NOT NULL) 전용 복합 unique
--
-- 주의: fragments.key_id는 TEXT (migration-004, migration-027 확인)
-- 멱등: IF EXISTS / IF NOT EXISTS 가드 사용


-- 1) 기존 전역 UNIQUE 인덱스 drop
DROP INDEX IF EXISTS agent_memory.idx_frag_hash;

-- 2-a) master(key_id IS NULL) 전용 partial unique index
CREATE UNIQUE INDEX IF NOT EXISTS uq_frag_hash_master
    ON agent_memory.fragments (content_hash)
    WHERE key_id IS NULL;

-- 2-b) DB API key(key_id IS NOT NULL) 전용 복합 partial unique index
CREATE UNIQUE INDEX IF NOT EXISTS uq_frag_hash_per_key
    ON agent_memory.fragments (key_id, content_hash)
    WHERE key_id IS NOT NULL;

