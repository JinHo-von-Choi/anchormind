-- 검토 대기열 결정 기록 표와 review_state 값 제약
--
-- 작성자: 최진호
-- 작성일: 2026-10-03
--
-- fragments.review_state와 review_reason 열은 migration-057이 더했다. 이 파일은 review_state 값
-- (pending, approved, rejected)을 NOT VALID CHECK 제약으로 붙이고, 승인과 거절과 자동 거절을 남기는
-- memory_review_decisions 표를 만든다. 결정 표는 파편 본문을 싣지 않는다(파편 id, 결정, 결정자, 메모,
-- 멱등 키, 키 id, 결정 시점의 사유). 파편은 GC로 지워질 수 있으므로 fragment_id에 외래 키를 걸지 않는다.
--
-- 키의 검토 방식(off, flagged, all)은 api_keys 열이 아니라 키 권한 목록의 표지(review_off, review_all)로
-- 둔다. 권한 목록은 이미 세션 재확인 캐시로 쓰기 경로에 전달되므로 쓰기마다 키 조회를 더하지 않는다.
--
-- fragments 제약은 NOT VALID로 붙여 기존 행을 훑지 않는다. 기존 행은 모두 NULL이라 나중에
-- VALIDATE CONSTRAINT를 실행해도 위반이 없다. 제약 추가는 짧게 표 전체 잠금을 잡으므로 잠금 대기를
-- 3초로 제한한다(docs/operations/online-migration.md). 새 표의 색인은 빈 표에 만드는 작은 표 변경이다.

SET LOCAL lock_timeout = '3s';

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'agent_memory.fragments'::regclass
       AND conname  = 'fragments_review_state_check'
  ) THEN
    ALTER TABLE agent_memory.fragments
      ADD CONSTRAINT fragments_review_state_check CHECK (
        review_state IS NULL OR review_state IN ('pending', 'approved', 'rejected')
      ) NOT VALID;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS agent_memory.memory_review_decisions (
  id              BIGSERIAL   PRIMARY KEY,
  fragment_id     TEXT        NOT NULL,
  decision        TEXT        NOT NULL,
  reviewer        TEXT        NOT NULL,
  note            TEXT,
  idempotency_key TEXT,
  key_id          TEXT,
  review_reason   TEXT,
  decided_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT memory_review_decisions_decision_check
    CHECK (decision IN ('approve', 'reject', 'auto_reject')),
  CONSTRAINT memory_review_decisions_note_check
    CHECK (note IS NULL OR char_length(note) <= 500),
  CONSTRAINT memory_review_decisions_idempotency_key_check
    CHECK (idempotency_key IS NULL OR char_length(idempotency_key) BETWEEN 1 AND 128),
  CONSTRAINT memory_review_decisions_reviewer_check
    CHECK (char_length(reviewer) BETWEEN 1 AND 128)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_memory_review_decisions_idempotency
  ON agent_memory.memory_review_decisions (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_memory_review_decisions_fragment
  ON agent_memory.memory_review_decisions (fragment_id, decided_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_review_decisions_decided_at
  ON agent_memory.memory_review_decisions (decided_at DESC);

COMMENT ON TABLE agent_memory.memory_review_decisions
  IS '검토 대기열 결정 기록(승인, 거절, 30일 미결정 자동 거절). 파편 본문을 싣지 않는다';
COMMENT ON COLUMN agent_memory.memory_review_decisions.reviewer
  IS '결정 주체 표기(master, admin 세션 표기, system)';
COMMENT ON COLUMN agent_memory.memory_review_decisions.note
  IS '결정 메모. 저장 전에 민감 정보 마스킹을 거친다';
COMMENT ON COLUMN agent_memory.memory_review_decisions.idempotency_key
  IS '결정 재시도 멱등 키. 같은 키의 재요청은 앞선 결정을 돌려준다';
