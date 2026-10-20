-- migration-068-synthetic-query-origin.sql
--
-- 작성자: 최진호
-- 작성일: 2026-10-20
--
-- fragment_synthetic_query는 LLM이 만든 역질의만 담았다. reflect의 교훈(lessons)이 남긴 상황 단서(cue)도
-- 같은 보조 벡터 검색 경로로 찾도록 이 표에 넣는다. 두 출처는 수명이 달라 열로 구분한다.
--
--   origin  generated  SyntheticQueryWorker가 본문에서 만든 역질의. 본문이 바뀌면 지우고 다시 만든다.
--           cue        교훈의 상황 단서. 본문이 바뀌어도 상황은 그대로이므로 남기고 버전만 맞춘다.
--
-- 백필 수집기는 generated 행만 보고 미생성 파편을 고른다. cue 행이 있다고 역질의 생성을 건너뛰지 않는다.
-- 멱등: ADD COLUMN IF NOT EXISTS, 제약은 DROP IF EXISTS 후 추가

ALTER TABLE agent_memory.fragment_synthetic_query
    ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'generated';

ALTER TABLE agent_memory.fragment_synthetic_query
    DROP CONSTRAINT IF EXISTS fragment_synthetic_query_origin_check;
ALTER TABLE agent_memory.fragment_synthetic_query
    ADD CONSTRAINT fragment_synthetic_query_origin_check CHECK (origin IN ('generated', 'cue'));

COMMENT ON COLUMN agent_memory.fragment_synthetic_query.origin
  IS 'generated: 본문에서 만든 역질의, cue: reflect 교훈의 상황 단서';
