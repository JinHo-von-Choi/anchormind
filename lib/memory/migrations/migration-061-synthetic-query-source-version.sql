-- migration-061-synthetic-query-source-version.sql
--
-- 합성 역질의를 생성할 때의 원문 버전을 기록한다. nullable 열만 먼저 추가해 기존 대형 표를
-- 재작성하거나 잠금 시간을 늘리지 않으며, 워커 백필이 현재 원문과 다른 행을 점진적으로 교체한다.

ALTER TABLE agent_memory.fragment_synthetic_query
    ADD COLUMN IF NOT EXISTS source_content_hash TEXT;

COMMENT ON COLUMN agent_memory.fragment_synthetic_query.source_content_hash
  IS '합성 질의를 생성한 fragments.content_hash. 현재 해시와 같은 행만 검색에 사용한다.';
