-- migration-013-search-events.sql
-- 검색 이벤트 영속화: searchPath, tier별 카운트, latency 기록
-- tool_feedback과 FK 연결로 검색 경로별 관련성/충분성 교차 분석 가능
--
-- 실행: psql $DATABASE_URL -f lib/memory/migration-013-search-events.sql

CREATE TABLE IF NOT EXISTS agent_memory.search_events (
    id             BIGSERIAL    PRIMARY KEY,
    session_id     TEXT,
    key_id         INTEGER,
    search_path    TEXT         NOT NULL,
    l1_count       SMALLINT     NOT NULL DEFAULT 0,
    l2_count       SMALLINT     NOT NULL DEFAULT 0,
    l3_count       SMALLINT     NOT NULL DEFAULT 0,
    result_count   SMALLINT     NOT NULL DEFAULT 0,
    l1_is_fallback BOOLEAN      NOT NULL DEFAULT FALSE,
    used_rrf       BOOLEAN      NOT NULL DEFAULT FALSE,
    latency_ms     INTEGER,
    query_type     TEXT         CHECK (query_type IN ('keywords', 'text', 'topic', 'mixed')),
    filter_keys    TEXT[],
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_se_created
    ON agent_memory.search_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_se_session
    ON agent_memory.search_events (session_id)
    WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_se_query_type
    ON agent_memory.search_events (query_type);

-- tool_feedback에 search_event_id FK 추가
ALTER TABLE agent_memory.tool_feedback
    ADD COLUMN IF NOT EXISTS search_event_id BIGINT
        REFERENCES agent_memory.search_events(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_tf_search_event
    ON agent_memory.tool_feedback (search_event_id)
    WHERE search_event_id IS NOT NULL;
