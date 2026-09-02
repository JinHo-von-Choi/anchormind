-- effective agent 검색 범위 및 anchor agent 변경 이력 보존

ALTER TABLE agent_memory.search_events
  ADD COLUMN IF NOT EXISTS effective_agent_scope TEXT,
  ADD COLUMN IF NOT EXISTS include_peer_agents  BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE agent_memory.fragment_versions
  ADD COLUMN IF NOT EXISTS agent_id  TEXT,
  ADD COLUMN IF NOT EXISTS workspace TEXT;

ALTER TABLE agent_memory.case_events
  ADD COLUMN IF NOT EXISTS agent_id  TEXT,
  ADD COLUMN IF NOT EXISTS workspace TEXT;

-- 기존 행 backfill은 이 migration의 트랜잭션에서 수행하지 않는다. 대형 테이블의
-- 전 행 재작성과 코드 롤링 배포를 분리하기 위해 `anchor-scope --backfill-snapshots`가
-- 짧은 배치 단위로 처리한다. nullable 상태는 구버전 writer와 호환되며, 읽기
-- 경로는 NULL snapshot을 fail-closed로 제외한다.

COMMENT ON COLUMN agent_memory.search_events.effective_agent_scope
  IS '검색에 적용된 비식별 agent 범위: default-only, specific+default, all-agents';
COMMENT ON COLUMN agent_memory.search_events.include_peer_agents
  IS 'master가 명시적으로 peer-agent 전체 조회를 요청했는지 여부';
COMMENT ON COLUMN agent_memory.fragment_versions.agent_id
  IS 'amend 직전 fragment agent_id. NULL은 아직 backfill되지 않은 legacy snapshot.';
COMMENT ON COLUMN agent_memory.fragment_versions.workspace
  IS 'amend 직전 fragment workspace. history hydration 범위 검증용.';
COMMENT ON COLUMN agent_memory.case_events.agent_id
  IS 'event 생성 시 source fragment agent scope snapshot. NULL legacy row는 non-peer 조회 제외.';
COMMENT ON COLUMN agent_memory.case_events.workspace
  IS 'event 생성 시 source fragment workspace snapshot.';
