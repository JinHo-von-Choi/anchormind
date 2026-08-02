-- migration-038-fragment-versions-case-fields.sql
-- 작성자: 최진호
-- 작성일: 2026-08-02
-- 목적: amend가 케이스 상태(resolution_status, outcome, phase)를 갱신할 수 있게 되면서
--       변경 전 상태를 이력 테이블에도 보존한다. 세 컬럼 모두 nullable이므로
--       구버전 writer와 혼재되는 롤링 배포 구간에서도 호환된다.
-- 멱등: ADD COLUMN IF NOT EXISTS


ALTER TABLE agent_memory.fragment_versions
  ADD COLUMN IF NOT EXISTS resolution_status TEXT,
  ADD COLUMN IF NOT EXISTS outcome           TEXT,
  ADD COLUMN IF NOT EXISTS phase             TEXT;

COMMENT ON COLUMN agent_memory.fragment_versions.resolution_status
  IS 'amend 직전의 케이스 해결 상태. 종결 전후 대조용.';
COMMENT ON COLUMN agent_memory.fragment_versions.outcome
  IS 'amend 직전의 케이스 결과 요약.';
COMMENT ON COLUMN agent_memory.fragment_versions.phase
  IS 'amend 직전의 작업 단계.';
