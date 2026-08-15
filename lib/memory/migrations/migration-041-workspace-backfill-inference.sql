-- migration-041-workspace-backfill-inference.sql
--
-- 작성자: 최진호
-- 작성일: 2026-08-15
--
-- 기존 파편의 workspace를 직접 UPDATE하지 않고, 추론 결과를 별도 컬럼에
-- 감사 추적 가능한 형태로 기록하기 위한 컬럼 3종.
--   workspace_inferred: 추론된 workspace 값(승격 전까지 workspace 컬럼은 불변).
--   inference_confidence: 추론 근거의 신뢰도(0.0~1.0).
--   backfill_batch_id: 추론을 생성한 배치 실행 식별자. 배치 단위 롤백에 사용.
--
-- 멱등: ADD COLUMN IF NOT EXISTS + pg_constraint 존재 검사

ALTER TABLE agent_memory.fragments
  ADD COLUMN IF NOT EXISTS workspace_inferred    TEXT,
  ADD COLUMN IF NOT EXISTS inference_confidence  REAL,
  ADD COLUMN IF NOT EXISTS backfill_batch_id     TEXT;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fragments_inference_confidence_check'
          AND conrelid = 'agent_memory.fragments'::regclass
    ) THEN
        ALTER TABLE agent_memory.fragments
          ADD CONSTRAINT fragments_inference_confidence_check
          CHECK (inference_confidence IS NULL OR (inference_confidence >= 0.0 AND inference_confidence <= 1.0));
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_fragments_backfill_batch_id
    ON agent_memory.fragments (backfill_batch_id)
    WHERE backfill_batch_id IS NOT NULL;

COMMENT ON COLUMN agent_memory.fragments.workspace_inferred
  IS '결정론적 추론으로 산출한 workspace 후보값. workspace 컬럼을 직접 덮어쓰지 않는 비파괴 기록.';
COMMENT ON COLUMN agent_memory.fragments.inference_confidence
  IS 'workspace_inferred 판단의 신뢰도(0.0~1.0). NULL=추론 미실행.';
COMMENT ON COLUMN agent_memory.fragments.backfill_batch_id
  IS '해당 추론을 생성한 백필 배치 실행 식별자. 배치 단위 조회·롤백에 사용.';
