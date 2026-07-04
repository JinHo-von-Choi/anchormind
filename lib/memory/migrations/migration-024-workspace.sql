-- migration-024: Workspace isolation
-- fragments에 workspace 컬럼 추가 (NULL = 전역)
-- api_keys에 default_workspace 컬럼 추가
-- 검색 성능을 위한 복합 인덱스 추가

ALTER TABLE agent_memory.fragments
  ADD COLUMN IF NOT EXISTS workspace VARCHAR(255) DEFAULT NULL;

ALTER TABLE agent_memory.api_keys
  ADD COLUMN IF NOT EXISTS default_workspace VARCHAR(255) DEFAULT NULL;

-- 검색 성능: (key_id, workspace) 복합 인덱스
CREATE INDEX IF NOT EXISTS idx_fragments_key_workspace
  ON agent_memory.fragments (key_id, workspace)
  WHERE valid_to IS NULL;

-- workspace 단독 인덱스 (workspace 기반 전체 조회용)
CREATE INDEX IF NOT EXISTS idx_fragments_workspace
  ON agent_memory.fragments (workspace)
  WHERE workspace IS NOT NULL AND valid_to IS NULL;
