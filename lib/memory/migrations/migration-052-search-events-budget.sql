-- recall 예산 선택 단계의 후보 수와 선택 수
--
-- 작성자: 최진호
-- 작성일: 2026-10-03
--
-- 두 열 모두 기본값 없는 nullable 열이라 기존 행을 다시 쓰지 않는다. 예산 선택을 거치지 않은
-- 검색(MEMENTO_RANK_BEFORE_BUDGET=off, recall 밖의 검색 호출)은 NULL을 기록한다.
-- 열 추가는 짧게 표 전체 잠금을 잡으므로 잠금 대기를 3초로 제한한다(docs/operations/online-migration.md).

SET LOCAL lock_timeout = '3s';

ALTER TABLE agent_memory.search_events
  ADD COLUMN IF NOT EXISTS candidate_count INTEGER,
  ADD COLUMN IF NOT EXISTS budget_kept     INTEGER;

COMMENT ON COLUMN agent_memory.search_events.candidate_count
  IS 'recall 예산 선택에 들어간 후보 수(검색 후보와 연결 파편). 예산 선택을 거치지 않은 검색은 NULL';
COMMENT ON COLUMN agent_memory.search_events.budget_kept
  IS 'recall 예산 선택이 토큰 예산 안에 고른 수. 예산 선택을 거치지 않은 검색은 NULL';
