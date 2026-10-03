-- migration-054-outbox-events.sql
--
-- 작성자: 최진호
-- 작성일: 2026-10-03
--
-- outbox_events: 변경 트랜잭션 안에서 같은 연결로 기록하는 비동기 이벤트 표.
--
-- 생산자는 업무 변경과 같은 트랜잭션에서 행을 넣는다. 트랜잭션이 롤백되면 이벤트도
-- 남지 않고, 커밋되면 프로세스가 곧바로 종료되어도 이벤트는 남는다. 작업자는
-- FOR UPDATE SKIP LOCKED로 행을 점유하고 available_at을 임대 만료 시각으로 밀어 둔다.
-- 작업자가 처리 중에 죽으면 임대가 끝난 뒤 다른 작업자가 같은 행을 다시 점유한다.
--
-- 상태
--   대기: processed_at IS NULL AND dead_at IS NULL
--   완료: processed_at IS NOT NULL (보존 기간이 지나면 정리 작업이 묶음 단위로 지운다)
--   dead-letter: dead_at IS NOT NULL (자동으로 지우지 않는다)
--
-- 새 표이므로 비어 있는 상태에서 색인을 만든다. 대형 표 목록(fragments, fragment_links,
-- case_events, search_events)에 속하지 않는다.
--
-- 멱등: CREATE TABLE / INDEX IF NOT EXISTS

CREATE TABLE IF NOT EXISTS agent_memory.outbox_events (
    id            BIGSERIAL   PRIMARY KEY,
    topic         TEXT        NOT NULL,
    aggregate_id  TEXT,
    payload       JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    available_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    attempts      INTEGER     NOT NULL DEFAULT 0,
    processed_at  TIMESTAMPTZ,
    last_error    TEXT,
    dead_at       TIMESTAMPTZ,
    claim_token   UUID,
    CONSTRAINT outbox_events_topic_check
        CHECK (topic ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$' AND length(topic) <= 64),
    CONSTRAINT outbox_events_aggregate_check
        CHECK (aggregate_id IS NULL OR length(aggregate_id) BETWEEN 1 AND 200),
    CONSTRAINT outbox_events_attempts_check
        CHECK (attempts >= 0),
    CONSTRAINT outbox_events_state_check
        CHECK (processed_at IS NULL OR dead_at IS NULL)
);

-- 점유 순서(available_at, id)와 대기 건수. 대기 행만 담는다.
CREATE INDEX IF NOT EXISTS idx_outbox_events_due
    ON agent_memory.outbox_events (available_at, id)
    WHERE processed_at IS NULL AND dead_at IS NULL;

-- 보존 기간이 지난 완료 행 정리.
CREATE INDEX IF NOT EXISTS idx_outbox_events_processed
    ON agent_memory.outbox_events (processed_at)
    WHERE processed_at IS NOT NULL;

-- dead-letter 건수와 조회.
CREATE INDEX IF NOT EXISTS idx_outbox_events_dead
    ON agent_memory.outbox_events (dead_at)
    WHERE dead_at IS NOT NULL;

COMMENT ON TABLE agent_memory.outbox_events
  IS '변경 트랜잭션 안에서 기록하는 비동기 이벤트. 작업자가 topic별 처리기로 전달한다.';
COMMENT ON COLUMN agent_memory.outbox_events.available_at
  IS '대기 행은 이 시각 이후 점유할 수 있다. 점유하면 임대 만료 시각, 실패하면 재시도 시각이 된다.';
COMMENT ON COLUMN agent_memory.outbox_events.attempts
  IS '점유 횟수. 점유할 때 1 늘고, 처리하지 않고 돌려준 점유는 1 줄인다.';
COMMENT ON COLUMN agent_memory.outbox_events.claim_token
  IS '현재 점유의 표지. 완료와 실패 기록은 이 값이 같을 때만 반영된다.';
COMMENT ON COLUMN agent_memory.outbox_events.dead_at
  IS '재시도 한도를 넘었거나 처리기가 재시도 불가로 판정한 시각. 자동으로 지우지 않는다.';
