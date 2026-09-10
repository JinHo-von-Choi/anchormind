-- migration-047 수동 롤백.
-- 주의: 이 파일은 자동 실행되지 않는다. 먼저 이 릴리스의 writer/read 경로를
-- 이전 버전으로 되돌린 뒤 실행해야 하며 snapshot 데이터가 삭제된다.
-- anchor-scope --execute의 fragments.agent_id 정규화는 되돌리지 않는다.
-- 재적용/재백필은 현재 agent 값(default)을 복사하므로 정규화 전 상태를
-- 복원하려면 실행 전 별도 백업이 필요하다.

BEGIN;

ALTER TABLE agent_memory.search_events
  DROP COLUMN IF EXISTS effective_agent_scope,
  DROP COLUMN IF EXISTS include_peer_agents;

ALTER TABLE agent_memory.fragment_versions
  DROP COLUMN IF EXISTS agent_id,
  DROP COLUMN IF EXISTS workspace;

ALTER TABLE agent_memory.case_events
  DROP COLUMN IF EXISTS agent_id,
  DROP COLUMN IF EXISTS workspace;

DELETE FROM agent_memory.schema_migrations
 WHERE filename = 'migration-047-agent-scope-audit.sql';

COMMIT;
