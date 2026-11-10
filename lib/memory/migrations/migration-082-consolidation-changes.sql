-- migration-082-consolidation-changes.sql
--
-- 작성자: 최진호
-- 작성일: 2026-11-10
--
-- 정리 주기(MemoryConsolidator)의 변경 기록. 주기마다 cycle_id를 정하고, 파편을 닫거나(closed), 만들거나(created),
-- 앵커로 올린(anchored) 단계가 같은 SQL 문장에서 이 표에 한 줄씩 남긴다. 관리 API가 cycle_id 단위로 되돌린다
-- (lib/memory/consolidate/ConsolidationRollback.js). before는 되돌릴 때 복원할 열 값이다.
-- fragment_id에는 외래 키를 걸지 않는다. 기록은 파편이 지워진 뒤에도 남아야 무엇을 되돌릴 수 없었는지 알 수 있다.
-- 멱등: 표와 색인이 이미 있으면 다시 만들지 않는다.

CREATE TABLE IF NOT EXISTS agent_memory.consolidation_changes (
  id             BIGSERIAL   PRIMARY KEY,
  cycle_id       TEXT        NOT NULL CHECK (length(cycle_id) BETWEEN 1 AND 64),
  stage          TEXT        NOT NULL CHECK (length(stage) BETWEEN 1 AND 64),
  action         TEXT        NOT NULL CHECK (action IN ('closed', 'created', 'anchored')),
  fragment_id    TEXT        NOT NULL,
  successor_id   TEXT,
  before         JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  rolled_back_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_consolidation_changes_cycle ON agent_memory.consolidation_changes (cycle_id, id);
CREATE INDEX IF NOT EXISTS idx_consolidation_changes_created ON agent_memory.consolidation_changes (created_at);
