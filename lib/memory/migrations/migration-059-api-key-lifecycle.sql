-- migration-059-api-key-lifecycle.sql
--
-- 작성자: 최진호
-- 작성일: 2026-10-03
--
-- API 키 수명 열과 키 비밀 표.
--
-- api_keys에 수명 열을 더한다. 모두 NULL 허용이며 NULL은 제한 없음이다. 기존 키는 값이 비어 있어
-- 인증 결과가 같다.
--   expires_at          이 시각부터 키를 거부한다
--   description, owner, kind  관리 표시용 설명, 소유자, 종류
--   allowed_cidrs       요청 주소가 이 대역 중 하나에 들어야 한다. 빈 배열은 모든 주소 거부
--   last_used_ip_hash   마지막 사용 주소의 HMAC 지문(앞 32자). 주소 원문은 저장하지 않는다
--   revoked_at, revoked_by, revoke_reason  폐기 기록. 폐기한 키는 다시 활성화하지 않는다
--   access_reviewed_at, access_reviewed_by 접근 검토 서명
--
-- api_key_secrets는 원시 키의 SHA-256 해시를 키별로 여러 개 담는다. 인증은 이 표를 먼저 보고, 해시가
-- 없으면 api_keys.key_hash를 본다. 회전은 새 해시 행을 더하고 이전 행의 valid_until을 겹침 종료 시각으로
-- 정한다. api_keys.key_hash는 늘 현재 해시와 같다. 기존 키의 해시는 scripts/ops/backfill-key-secrets.mjs가
-- 일괄 insert-select로 옮긴다(멱등).
--
-- api_keys는 작은 표다. 열 추가와 외래 키는 짧은 잠금을 잡으므로 대기 상한을 둔다.
--
-- 멱등: ADD COLUMN IF NOT EXISTS, CREATE TABLE / INDEX IF NOT EXISTS

SET LOCAL lock_timeout = '3s';

ALTER TABLE agent_memory.api_keys
  ADD COLUMN IF NOT EXISTS expires_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS description        TEXT,
  ADD COLUMN IF NOT EXISTS owner              TEXT,
  ADD COLUMN IF NOT EXISTS kind               TEXT,
  ADD COLUMN IF NOT EXISTS allowed_cidrs      TEXT[],
  ADD COLUMN IF NOT EXISTS last_used_ip_hash  TEXT,
  ADD COLUMN IF NOT EXISTS revoked_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revoked_by         TEXT,
  ADD COLUMN IF NOT EXISTS revoke_reason      TEXT,
  ADD COLUMN IF NOT EXISTS access_reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS access_reviewed_by TEXT;

COMMENT ON COLUMN agent_memory.api_keys.expires_at
  IS '이 시각부터 키를 거부한다. NULL=무기한(기본값, 하위 호환).';
COMMENT ON COLUMN agent_memory.api_keys.allowed_cidrs
  IS '요청 주소가 들어야 하는 IPv4/IPv6 대역 목록. NULL=제한 없음(기본값). 빈 배열=모든 주소 거부. 잘못된 항목이 있으면 모든 주소 거부.';
COMMENT ON COLUMN agent_memory.api_keys.revoked_at
  IS '폐기 시각. 값이 있으면 키와 모든 비밀 행을 거부한다.';

CREATE TABLE IF NOT EXISTS agent_memory.api_key_secrets (
    key_hash    TEXT        PRIMARY KEY,
    key_id      TEXT        NOT NULL REFERENCES agent_memory.api_keys(id) ON DELETE CASCADE,
    key_prefix  TEXT        NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    valid_until TIMESTAMPTZ,
    status      TEXT        NOT NULL DEFAULT 'active',
    CONSTRAINT api_key_secrets_status_check CHECK (status IN ('active', 'revoked'))
);

COMMENT ON TABLE agent_memory.api_key_secrets
  IS '키별 원시 키 SHA-256 해시. 인증이 api_keys.key_hash보다 먼저 본다. valid_until=회전 겹침 종료 시각(NULL=무기한).';

CREATE INDEX IF NOT EXISTS idx_api_key_secrets_key_id
    ON agent_memory.api_key_secrets (key_id);
