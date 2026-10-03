-- migration-055-api-keys-egress-policy.sql
--
-- 작성자: 최진호
-- 작성일: 2026-10-03
--
-- api_keys.egress_policy: 키의 LLM 외부 전송 정책(jsonb). NULL이면 정책 없음이며, 기존 LLM 기능은
-- 구성된 제공자를 그대로 쓴다. 값의 형식과 판정은 lib/llm/EgressPolicy.js와
-- docs/configuration.md 「외부 전송 정책」에 있다. 편집은 PATCH /keys/:id/policy의 egress_policy 필드다.
--
-- api_keys는 작은 표이고 nullable 열 추가는 행을 다시 쓰지 않는다. 인증 경로가 이 표를 자주 읽으므로
-- 표 잠금을 오래 기다리지 않게 lock_timeout을 둔다.
--
-- 멱등: ADD COLUMN IF NOT EXISTS

SET LOCAL lock_timeout = '3s';

ALTER TABLE agent_memory.api_keys
  ADD COLUMN IF NOT EXISTS egress_policy JSONB;

COMMENT ON COLUMN agent_memory.api_keys.egress_policy
  IS 'LLM 외부 전송 정책 {local_only, approved_providers, workspaces}. NULL=정책 없음(기존 LLM 기능은 구성된 제공자 사용).';
