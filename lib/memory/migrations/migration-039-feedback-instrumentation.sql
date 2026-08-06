-- migration-039-feedback-instrumentation.sql
--
-- 작성자: 최진호
-- 작성일: 2026-08-06
--
-- 목적: 피드백 계측 확장.
--   task_feedback에 작업 종료 상태(outcome), 평가 주체(evaluator), 판단 근거(evidence),
--   미충족 요구사항(unmet_requirements)을 기록한다.
--   tool_feedback에 무관 판정 원인(irrelevance_reason)을 기록한다.
--   기존 행은 전부 NULL로 남는다. 백필하지 않으므로 NULL은 "미보고"를 뜻하며
--   보고된 값과 구분 가능하다.
--
-- 멱등: ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS + pg_constraint 존재 검사

ALTER TABLE agent_memory.task_feedback
  ADD COLUMN IF NOT EXISTS outcome            TEXT,
  ADD COLUMN IF NOT EXISTS evaluator          TEXT,
  ADD COLUMN IF NOT EXISTS evidence           TEXT,
  ADD COLUMN IF NOT EXISTS unmet_requirements TEXT[];

ALTER TABLE agent_memory.tool_feedback
  ADD COLUMN IF NOT EXISTS irrelevance_reason TEXT;

-- 무관 판정만 스캔하는 partial index. 원인 분포 집계가 전체 테이블을 훑지 않게 한다.
CREATE INDEX IF NOT EXISTS idx_tf_irrelevance
    ON agent_memory.tool_feedback (irrelevance_reason)
    WHERE irrelevance_reason IS NOT NULL;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'task_feedback_outcome_check'
          AND conrelid = 'agent_memory.task_feedback'::regclass
    ) THEN
        ALTER TABLE agent_memory.task_feedback
          ADD CONSTRAINT task_feedback_outcome_check
          CHECK (outcome IS NULL OR outcome IN ('completed', 'partial', 'blocked', 'abandoned', 'unknown'));
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'task_feedback_evaluator_check'
          AND conrelid = 'agent_memory.task_feedback'::regclass
    ) THEN
        ALTER TABLE agent_memory.task_feedback
          ADD CONSTRAINT task_feedback_evaluator_check
          CHECK (evaluator IS NULL OR evaluator IN ('agent', 'automatic', 'human'));
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'tool_feedback_irrelevance_reason_check'
          AND conrelid = 'agent_memory.tool_feedback'::regclass
    ) THEN
        ALTER TABLE agent_memory.tool_feedback
          ADD CONSTRAINT tool_feedback_irrelevance_reason_check
          CHECK (irrelevance_reason IS NULL OR irrelevance_reason IN ('not_stored', 'search_miss', 'scope_leak', 'topic_mismatch', 'other'));
    END IF;
END $$;

COMMENT ON COLUMN agent_memory.task_feedback.outcome
  IS '작업 종료 상태. completed=요구사항 전부 충족, partial=일부만 충족, blocked=외부 요인으로 진행 불가, abandoned=중단, unknown=판정 불가. NULL은 미보고.';
COMMENT ON COLUMN agent_memory.task_feedback.evaluator
  IS '평가 주체. agent=에이전트 자기보고, automatic=테스트·빌드 등 자동 판정, human=사용자 확인. NULL은 미보고.';
COMMENT ON COLUMN agent_memory.task_feedback.evidence
  IS 'outcome 판정 근거 요약(최대 1000자). 자기보고 편향 검토용.';
COMMENT ON COLUMN agent_memory.task_feedback.unmet_requirements
  IS '충족하지 못한 요구사항 목록. 비어있지 않으면 outcome=completed와 상충하므로 리포트에서 대조한다.';
COMMENT ON COLUMN agent_memory.tool_feedback.irrelevance_reason
  IS 'relevant=false일 때의 원인. not_stored=애초에 저장된 적 없음, search_miss=저장됐으나 검색되지 않음, scope_leak=타 스코프 파편 유입, topic_mismatch=주제 불일치, other=그 외. NULL은 미보고.';
