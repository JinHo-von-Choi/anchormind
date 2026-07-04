-- migration-021-oauth-clients.sql
-- Dynamic Client Registration (RFC 7591) 지원
--
-- 작성자: 최진호
-- 작성일: 2026-04-02

CREATE TABLE IF NOT EXISTS agent_memory.oauth_clients (
    client_id       TEXT PRIMARY KEY,
    client_name     TEXT,
    redirect_uris   TEXT[] NOT NULL DEFAULT '{}',
    grant_types     TEXT[] NOT NULL DEFAULT '{authorization_code,refresh_token}',
    response_types  TEXT[] NOT NULL DEFAULT '{code}',
    scope           TEXT DEFAULT 'mcp',
    client_uri      TEXT,
    logo_uri        TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_oauth_clients_created
  ON agent_memory.oauth_clients (created_at DESC);
