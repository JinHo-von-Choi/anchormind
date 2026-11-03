-- migration-078-key-retention-policies.sql
--
-- 작성자: 최진호
-- 작성일: 2026-11-04
--
-- 키(또는 키의 workspace 하나)마다 파편 최대 보존 일수를 둔다. 정리 주기의 retention_expire 단계가
-- created_at이 이 일수보다 오래된 파편을 지운다(lib/memory/consolidate/RetentionGC.js). 앵커는 지우지 않는다.
--   workspace NULL   키의 모든 workspace(전역 파편 포함)에 적용
--   workspace 'W'    그 workspace 파편에만 적용. 같은 키의 NULL 정책보다 우선한다
-- 키를 지우면 정책도 지운다. TTL 계층(전역 규칙)과 함께 적용되고, 둘 중 먼저 닿는 쪽에서 지워진다.
-- 멱등: 표와 색인이 이미 있으면 다시 만들지 않는다.

CREATE TABLE IF NOT EXISTS agent_memory.key_retention_policies (
  key_id       TEXT        NOT NULL REFERENCES agent_memory.api_keys(id) ON DELETE CASCADE,
  workspace    TEXT,
  max_age_days INTEGER     NOT NULL CHECK (max_age_days BETWEEN 1 AND 36500),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (workspace IS NULL OR length(workspace) BETWEEN 1 AND 128)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_key_retention_policies_scope
  ON agent_memory.key_retention_policies (key_id, COALESCE(workspace, ''));
