-- migration-048 수동 롤백.
-- 주의: 이 파일은 자동 실행되지 않는다. case_closed 행이 남아 있으면
-- ADD CONSTRAINT가 실패하므로 먼저 해당 행을 삭제하거나 다른 유형으로 바꿔야 한다.

BEGIN;

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
    'verification_failed'
  ));

DELETE FROM agent_memory.schema_migrations
 WHERE filename = 'migration-048-case-events-case-closed.sql';

COMMIT;
