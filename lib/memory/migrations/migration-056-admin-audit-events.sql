-- migration-056-admin-audit-events.sql
--
-- 작성자: 최진호
-- 작성일: 2026-10-03
--
-- admin_audit_events: 감사 이벤트의 단일 순차 해시 체인.
--
-- 생산자는 outbox_events에 topic audit.record 이벤트를 남기고, outbox 소비자가 이 표에 한 행씩
-- 옮긴다. 소비자는 표를 SHARE ROW EXCLUSIVE로 잠근 트랜잭션 안에서 마지막 행(seq 최댓값)의
-- row_hash를 읽고 seq = 마지막 + 1, prev_hash = 마지막 row_hash로 새 행을 기록한다. 따라서 작업자가
-- 여럿이어도 체인은 갈라지지 않는다. 첫 행의 prev_hash는 0 64개다.
--
-- row_hash = sha256(prev_hash || 줄바꿈 || 행 값의 정규 JSON). 정규 JSON의 열 목록과 순서는
-- lib/logging/audit-chain.js가 정한다.
--
-- detail에는 기억 본문과 비밀을 담지 않는다. 본문은 sha256과 길이만 담는다.
-- source_event는 outbox 멱등 키(topic:id)이고, 같은 이벤트의 재전달은 행을 늘리지 않는다.
--
-- 보존 정리는 오래된 앞부분(seq가 가장 작은 행부터)만 지우고 마지막 행은 남긴다. 남은 첫 행의
-- prev_hash가 검증의 기준점이 된다.
--
-- 새 표이므로 비어 있는 상태에서 색인을 만든다. 대형 표 목록(fragments, fragment_links,
-- case_events, search_events)에 속하지 않는다.
--
-- 멱등: CREATE TABLE / INDEX IF NOT EXISTS

CREATE TABLE IF NOT EXISTS agent_memory.admin_audit_events (
    seq           BIGINT      PRIMARY KEY,
    source_event  TEXT        NOT NULL,
    occurred_at   TIMESTAMPTZ NOT NULL,
    recorded_at   TIMESTAMPTZ NOT NULL,
    action        TEXT        NOT NULL,
    outcome       TEXT        NOT NULL,
    actor_kind    TEXT        NOT NULL,
    actor_key_id  TEXT,
    actor_session TEXT,
    actor_ip      TEXT,
    target_type   TEXT,
    target_id     TEXT,
    workspace     TEXT,
    detail        JSONB       NOT NULL DEFAULT '{}'::jsonb,
    prev_hash     TEXT        NOT NULL,
    row_hash      TEXT        NOT NULL,
    CONSTRAINT admin_audit_events_source_event_key UNIQUE (source_event),
    CONSTRAINT admin_audit_events_seq_check
        CHECK (seq >= 1),
    CONSTRAINT admin_audit_events_action_check
        CHECK (action ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$' AND length(action) <= 64),
    CONSTRAINT admin_audit_events_outcome_check
        CHECK (outcome IN ('success', 'failure', 'denied')),
    CONSTRAINT admin_audit_events_actor_kind_check
        CHECK (actor_kind IN ('master', 'key', 'anonymous', 'system')),
    CONSTRAINT admin_audit_events_hash_check
        CHECK (prev_hash ~ '^[0-9a-f]{64}$' AND row_hash ~ '^[0-9a-f]{64}$')
);

-- 기간 조회와 보존 정리.
CREATE INDEX IF NOT EXISTS idx_admin_audit_events_occurred
    ON agent_memory.admin_audit_events (occurred_at);
CREATE INDEX IF NOT EXISTS idx_admin_audit_events_recorded
    ON agent_memory.admin_audit_events (recorded_at);

-- 행위 이름 조회(최근 순).
CREATE INDEX IF NOT EXISTS idx_admin_audit_events_action
    ON agent_memory.admin_audit_events (action, seq DESC);

-- 행위자 조회. 키 행위자만 담는다.
CREATE INDEX IF NOT EXISTS idx_admin_audit_events_actor
    ON agent_memory.admin_audit_events (actor_key_id, seq DESC)
    WHERE actor_key_id IS NOT NULL;

-- 대상 조회.
CREATE INDEX IF NOT EXISTS idx_admin_audit_events_target
    ON agent_memory.admin_audit_events (target_type, target_id, seq DESC)
    WHERE target_id IS NOT NULL;

COMMENT ON TABLE agent_memory.admin_audit_events
  IS '감사 이벤트의 단일 순차 해시 체인. outbox 소비자가 audit.record 이벤트를 한 행씩 기록한다.';
COMMENT ON COLUMN agent_memory.admin_audit_events.seq
  IS '체인 위치. 기록할 때 표를 잠그고 마지막 seq + 1을 쓴다.';
COMMENT ON COLUMN agent_memory.admin_audit_events.source_event
  IS 'outbox 멱등 키(topic:id). 같은 이벤트의 재전달은 행을 늘리지 않는다.';
COMMENT ON COLUMN agent_memory.admin_audit_events.detail
  IS '행위별 부가 값. 기억 본문과 비밀은 담지 않고 본문은 sha256과 길이만 담는다.';
COMMENT ON COLUMN agent_memory.admin_audit_events.row_hash
  IS 'sha256(prev_hash, 줄바꿈, 행 값의 정규 JSON). lib/logging/audit-chain.js가 계산하고 검증한다.';
