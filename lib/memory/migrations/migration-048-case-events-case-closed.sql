-- case_events.event_type 허용 목록에 case_closed 추가
-- amend가 resolutionStatus=resolved 전환 시 기록하는 케이스 종결 이벤트를 수용한다.

ALTER TABLE agent_memory.case_events
  DROP CONSTRAINT IF EXISTS case_events_event_type_check;

ALTER TABLE agent_memory.case_events
  ADD CONSTRAINT case_events_event_type_check
  CHECK (event_type IN (
    'milestone_reached',
    'hypothesis_proposed',
    'hypothesis_rejected',
    'decision_committed',
    'error_observed',
    'fix_attempted',
    'verification_passed',
    'verification_failed',
    'case_closed'
  ));

COMMENT ON COLUMN agent_memory.case_events.event_type
  IS '케이스 이벤트 유형. case_closed는 amend(resolutionStatus=resolved)가 기록하는 종결 이벤트.';
