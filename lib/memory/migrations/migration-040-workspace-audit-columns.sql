-- migration-040-workspace-audit-columns.sql
--
-- 작성자: 최진호
-- 작성일: 2026-08-15
--
-- fragments.workspace_source: workspace 값이 어떤 경로로 채워졌는지 기록한다.
--   explicit=호출자 명시, key_default=키의 default_workspace 적용,
--   inferred=자동 추론 배정, unscoped=의도적 전역(NULL) 지정. NULL은 미기록(과거 행).
-- fragments.quality_rationale: 자동 품질 평가 근거 문장을 keywords와 분리해 보관한다.
--
-- 멱등: ADD COLUMN IF NOT EXISTS + pg_constraint 존재 검사

ALTER TABLE agent_memory.fragments
  ADD COLUMN IF NOT EXISTS workspace_source  TEXT,
  ADD COLUMN IF NOT EXISTS quality_rationale TEXT;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fragments_workspace_source_check'
          AND conrelid = 'agent_memory.fragments'::regclass
    ) THEN
        ALTER TABLE agent_memory.fragments
          ADD CONSTRAINT fragments_workspace_source_check
          CHECK (workspace_source IS NULL OR workspace_source IN ('explicit', 'key_default', 'inferred', 'unscoped'));
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_fragments_workspace_source
    ON agent_memory.fragments (workspace_source)
    WHERE workspace_source IS NOT NULL;

COMMENT ON COLUMN agent_memory.fragments.workspace_source
  IS 'workspace 값의 기입 경로. explicit=호출자 명시, key_default=키 기본값 적용, inferred=자동 추론, unscoped=의도적 전역. NULL=미기록(과거 행).';
COMMENT ON COLUMN agent_memory.fragments.quality_rationale
  IS '자동 품질 평가 근거 문장. keywords 오염 방지를 위해 분리 보관. NULL=미평가.';
