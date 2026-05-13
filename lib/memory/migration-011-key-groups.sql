-- Migration 011: API 키 그룹 (N:M 매핑)
-- 작성자: 최진호 / 2026-03-15


CREATE TABLE IF NOT EXISTS agent_memory.api_key_groups (
    id          TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
    name        TEXT        NOT NULL UNIQUE,
    description TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent_memory.api_key_group_members (
    group_id    TEXT NOT NULL REFERENCES agent_memory.api_key_groups(id) ON DELETE CASCADE,
    key_id      TEXT NOT NULL REFERENCES agent_memory.api_keys(id)      ON DELETE CASCADE,
    joined_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (group_id, key_id)
);

CREATE INDEX IF NOT EXISTS idx_group_members_key_id
    ON agent_memory.api_key_group_members(key_id);

