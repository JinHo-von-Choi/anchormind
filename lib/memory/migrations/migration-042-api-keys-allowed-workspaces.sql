-- migration-042-api-keys-allowed-workspaces.sql
--
-- 작성자: 최진호
-- 작성일: 2026-08-15
--
-- api_keys.allowed_workspaces: 해당 키가 remember/recall 등에서 주장할 수 있는
-- workspace 값의 허용 목록. NULL이면 무제한(현행 동작 유지, 하위 호환).
-- 빈 배열('{}')은 명시적으로 workspace 주장을 전면 차단하는 의미로 사용 가능.
--
-- 멱등: ADD COLUMN IF NOT EXISTS

ALTER TABLE agent_memory.api_keys
  ADD COLUMN IF NOT EXISTS allowed_workspaces TEXT[];

COMMENT ON COLUMN agent_memory.api_keys.allowed_workspaces
  IS '이 키가 주장할 수 있는 workspace 값 목록. NULL=무제한(기본값, 하위 호환). 빈 배열=workspace 주장 전면 차단.';
