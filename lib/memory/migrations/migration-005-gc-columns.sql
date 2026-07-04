-- migration-005-gc-columns.sql
-- GC 정책 강화를 위한 인덱스 추가
--
-- 작성자: 최진호
-- 작성일: 2026-03-07
--
-- 실행: psql $DATABASE_URL -f lib/memory/migration-005-gc-columns.sql

CREATE INDEX IF NOT EXISTS idx_frag_utility
    ON agent_memory.fragments(utility_score ASC)
    WHERE ttl_tier NOT IN ('permanent') AND is_anchor = FALSE;

CREATE INDEX IF NOT EXISTS idx_frag_access_count
    ON agent_memory.fragments(access_count)
    WHERE access_count = 0;
