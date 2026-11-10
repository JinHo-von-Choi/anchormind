-- migration-081-fragment-lineage.sql
--
-- 작성자: 최진호
-- 작성일: 2026-11-10
--
-- 파생 파편의 계보와 근거 상태.
--   fragment_lineage   파생 파편(child)과 그 원본(parent)의 관계. split은 분할 자식, lesson은 reflect 교훈과
--                      그 근거 파편이다. parent_id에는 외래 키를 걸지 않는다. 원본이 지워진 뒤에도 계보가 남아야
--                      자식의 근거 상태를 판정할 수 있다. 자식이 지워지면 계보 행도 지운다.
--   fragments.support_state  원본의 철회가 자식에 미친 상태. revoked는 원본이 forget, 거절(rejected), 사용자
--                      대체(supersedes)로 철회된 경우, stale은 원본 본문이 amend로 바뀐 경우, parent_missing은
--                      원본이 없지만 철회인지 알 수 없는 경우다. revoked와 stale은 context 주입에서 빠지고,
--                      parent_missing은 표지만 단다. NULL은 근거 상태에 문제가 없다는 뜻이다.
-- 분할로 원본이 닫히는 것(valid_to 설정)과 만료 삭제는 구조 변경이라 자식에 전파하지 않는다.
-- 멱등: 표, 색인, 열, 제약이 이미 있으면 다시 만들지 않는다.

SET LOCAL lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS agent_memory.fragment_lineage (
  child_id            TEXT        NOT NULL REFERENCES agent_memory.fragments(id) ON DELETE CASCADE,
  parent_id           TEXT        NOT NULL,
  relation            TEXT        NOT NULL CHECK (relation IN ('split', 'lesson')),
  parent_content_hash TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (child_id, parent_id, relation),
  CHECK (child_id <> parent_id)
);

CREATE INDEX IF NOT EXISTS idx_fragment_lineage_parent ON agent_memory.fragment_lineage (parent_id);

ALTER TABLE agent_memory.fragment_lineage ENABLE ROW LEVEL SECURITY;

-- 계보는 자체 격리 축이 없고 자식 파편의 접근 가능성을 따른다.
DROP POLICY IF EXISTS fragment_lineage_isolation_policy ON agent_memory.fragment_lineage;
CREATE POLICY fragment_lineage_isolation_policy ON agent_memory.fragment_lineage
    USING (
        current_setting('app.current_agent_id', true) IN ('system', 'admin')
        OR EXISTS (
            SELECT 1 FROM agent_memory.fragments f
             WHERE f.id = fragment_lineage.child_id
        )
    )
    WITH CHECK (
        current_setting('app.current_agent_id', true) IN ('system', 'admin')
        OR EXISTS (
            SELECT 1 FROM agent_memory.fragments f
             WHERE f.id = fragment_lineage.child_id
        )
    );

ALTER TABLE agent_memory.fragments ADD COLUMN IF NOT EXISTS support_state      TEXT;
ALTER TABLE agent_memory.fragments ADD COLUMN IF NOT EXISTS support_reason     TEXT;
ALTER TABLE agent_memory.fragments ADD COLUMN IF NOT EXISTS support_changed_at TIMESTAMPTZ;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'agent_memory.fragments'::regclass
       AND conname  = 'fragments_support_state_check'
  ) THEN
    ALTER TABLE agent_memory.fragments
      ADD CONSTRAINT fragments_support_state_check CHECK (
        support_state IS NULL OR support_state IN ('revoked', 'stale', 'parent_missing')
      ) NOT VALID;
  END IF;
END $$;
