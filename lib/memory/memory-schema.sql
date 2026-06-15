/**
 * Agent Memory Schema - Fragment-Based Memory System
 *
 * 작성자: 최진호
 * 작성일: 2026-02-23
 * 수정일: 2026-02-25
 *
 * 실행: psql -U postgres -d memento -f memory-schema.sql
 */

CREATE SCHEMA IF NOT EXISTS agent_memory;

SET search_path TO agent_memory, public;

-- 파편(Fragment) 테이블
CREATE TABLE IF NOT EXISTS agent_memory.fragments (
    id            TEXT PRIMARY KEY,
    content       TEXT NOT NULL,
    topic         TEXT NOT NULL,
    keywords      TEXT[] NOT NULL DEFAULT '{}',
    type          TEXT NOT NULL CHECK (type IN ('fact','decision','error','preference','procedure','relation','episode')),
    importance    REAL NOT NULL DEFAULT 0.5 CHECK (importance >= 0 AND importance <= 1),
    content_hash  TEXT NOT NULL,
    source        TEXT,
    linked_to     TEXT[] DEFAULT '{}',
    agent_id      TEXT NOT NULL DEFAULT 'default',
    access_count  INTEGER DEFAULT 0,
    accessed_at   TIMESTAMPTZ,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    ttl_tier         TEXT DEFAULT 'warm' CHECK (ttl_tier IN ('short','hot','warm','cold','permanent')),
    estimated_tokens INTEGER DEFAULT 0,
    utility_score    REAL DEFAULT 1.0,
    verified_at      TIMESTAMPTZ DEFAULT NOW(),
    -- 차원 변경 시 scripts/post-migrate-flexible-embedding-dims.js 실행 (EMBEDDING_DIMENSIONS 환경변수 참조)
    -- >2000차원 모델(Gemini gemini-embedding-001 등)은 halfvec 타입으로 자동 전환됨 (pgvector ≥0.7.0 필요)
    embedding        vector(1536)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_frag_hash
    ON agent_memory.fragments(content_hash);
CREATE INDEX IF NOT EXISTS idx_frag_topic
    ON agent_memory.fragments(topic);
CREATE INDEX IF NOT EXISTS idx_frag_type
    ON agent_memory.fragments(type);
CREATE INDEX IF NOT EXISTS idx_frag_keywords
    ON agent_memory.fragments USING GIN(keywords);
CREATE INDEX IF NOT EXISTS idx_frag_importance
    ON agent_memory.fragments(importance DESC);
CREATE INDEX IF NOT EXISTS idx_frag_created
    ON agent_memory.fragments(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_frag_agent
    ON agent_memory.fragments(agent_id);
CREATE INDEX IF NOT EXISTS idx_frag_linked
    ON agent_memory.fragments USING GIN(linked_to);
CREATE INDEX IF NOT EXISTS idx_frag_ttl
    ON agent_memory.fragments(ttl_tier, created_at);
CREATE INDEX IF NOT EXISTS idx_frag_source
    ON agent_memory.fragments(source);
CREATE INDEX IF NOT EXISTS idx_frag_verified
    ON agent_memory.fragments(verified_at);

-- HNSW 벡터 인덱스 (임베딩 존재하는 행만)
CREATE INDEX IF NOT EXISTS idx_frag_embedding
    ON agent_memory.fragments
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 128)
    WHERE embedding IS NOT NULL;

-- 파편 연결 관계 테이블
CREATE TABLE IF NOT EXISTS agent_memory.fragment_links (
    id            BIGSERIAL PRIMARY KEY,
    from_id       TEXT NOT NULL REFERENCES agent_memory.fragments(id) ON DELETE CASCADE,
    to_id         TEXT NOT NULL REFERENCES agent_memory.fragments(id) ON DELETE CASCADE,
    relation_type TEXT DEFAULT 'related' CHECK (relation_type IN ('related','caused_by','resolved_by','part_of','contradicts','superseded_by','co_retrieved')),
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(from_id, to_id)
);

CREATE INDEX IF NOT EXISTS idx_link_from
    ON agent_memory.fragment_links(from_id);
CREATE INDEX IF NOT EXISTS idx_link_to
    ON agent_memory.fragment_links(to_id);

-- 도구 유용성 피드백 테이블
CREATE TABLE IF NOT EXISTS agent_memory.tool_feedback (
    id            BIGSERIAL PRIMARY KEY,
    tool_name     TEXT NOT NULL,
    relevant      BOOLEAN NOT NULL,
    sufficient    BOOLEAN NOT NULL,
    suggestion    TEXT,
    context       TEXT,
    session_id    TEXT,
    trigger_type  TEXT NOT NULL DEFAULT 'voluntary'
                  CHECK (trigger_type IN ('sampled', 'voluntary')),
    created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tf_tool
    ON agent_memory.tool_feedback(tool_name);
CREATE INDEX IF NOT EXISTS idx_tf_created
    ON agent_memory.tool_feedback(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tf_session
    ON agent_memory.tool_feedback(session_id);

-- 작업 레벨 피드백 테이블
CREATE TABLE IF NOT EXISTS agent_memory.task_feedback (
    id               BIGSERIAL PRIMARY KEY,
    session_id       TEXT NOT NULL,
    overall_success  BOOLEAN NOT NULL,
    tool_highlights  TEXT[],
    tool_pain_points TEXT[],
    created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_taskfb_session
    ON agent_memory.task_feedback(session_id);
CREATE INDEX IF NOT EXISTS idx_taskfb_created
    ON agent_memory.task_feedback(created_at DESC);

-- 파편 이력 보존 테이블
CREATE TABLE IF NOT EXISTS agent_memory.fragment_versions (
    id           BIGSERIAL PRIMARY KEY,
    fragment_id  TEXT NOT NULL REFERENCES agent_memory.fragments(id) ON DELETE CASCADE,
    content      TEXT NOT NULL,
    topic        TEXT,
    keywords     TEXT[],
    type         TEXT,
    importance   REAL,
    amended_at   TIMESTAMPTZ DEFAULT NOW(),
    amended_by   TEXT -- agent_id
);

CREATE INDEX IF NOT EXISTS idx_ver_frag ON agent_memory.fragment_versions(fragment_id);

-- fragments 테이블 기능 확장
ALTER TABLE agent_memory.fragments ADD COLUMN IF NOT EXISTS is_anchor BOOLEAN DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_frag_anchor ON agent_memory.fragments(is_anchor) WHERE is_anchor = TRUE;

-- Row-Level Security (RLS) 적용
ALTER TABLE agent_memory.fragments ENABLE ROW LEVEL SECURITY;

-- 에이전트 격리 정책: 세션 변수 'app.current_agent_id'와 일치하는 데이터만 접근 허용
-- agent_id가 'default'인 경우는 공용 데이터로 간주하여 조회 허용
-- 'system' 또는 'admin' 세션은 모든 데이터에 접근 허용 (유지보수용)
DROP POLICY IF EXISTS fragment_isolation_policy ON agent_memory.fragments;
CREATE POLICY fragment_isolation_policy ON agent_memory.fragments
    USING (
        agent_id = current_setting('app.current_agent_id', true)
        OR agent_id = 'default'
        OR current_setting('app.current_agent_id', true) IN ('system', 'admin')
    );

-- fragment_links는 fragments를 참조하므로 fragments의 RLS에 의해 간접적으로 보호됨
-- 하지만 명시적으로 ENABLE RLS를 할 수도 있음 (성능 고려 필요)
