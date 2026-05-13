-- Migration 003: API 키 관리 테이블
-- 작성자: 최진호 / 2026-03-03


-- API 키 마스터 테이블
-- 원시 키는 저장하지 않음. key_hash(SHA-256)와 key_prefix(표시용)만 보관.
CREATE TABLE IF NOT EXISTS agent_memory.api_keys (
    id           TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
    name         TEXT        NOT NULL UNIQUE,
    key_hash     TEXT        NOT NULL UNIQUE,
    key_prefix   TEXT        NOT NULL,
    permissions  TEXT[]      NOT NULL DEFAULT '{read}',
    status       TEXT        NOT NULL DEFAULT 'active'
                             CHECK (status IN ('active', 'inactive')),
    daily_limit  INTEGER     NOT NULL DEFAULT 10000
                             CHECK (daily_limit > 0),
    last_used_at TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 일별 사용량 (날짜 변경 시 자동 리셋 — 행 단위 추적)
CREATE TABLE IF NOT EXISTS agent_memory.api_key_usage (
    key_id     TEXT    NOT NULL REFERENCES agent_memory.api_keys(id) ON DELETE CASCADE,
    usage_date DATE    NOT NULL DEFAULT CURRENT_DATE,
    call_count INTEGER NOT NULL DEFAULT 0 CHECK (call_count >= 0),
    PRIMARY KEY (key_id, usage_date)
);

-- 조회 최적화 인덱스
CREATE INDEX IF NOT EXISTS idx_api_keys_status
    ON agent_memory.api_keys(status);

CREATE INDEX IF NOT EXISTS idx_api_keys_key_hash
    ON agent_memory.api_keys(key_hash);

CREATE INDEX IF NOT EXISTS idx_api_key_usage_date
    ON agent_memory.api_key_usage(usage_date);

