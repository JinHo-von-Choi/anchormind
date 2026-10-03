-- case_events 의 원본 파편 색인
--
-- 작성자: 최진호
-- 작성일: 2026-10-03
--
-- forget 삭제 연쇄(MEMENTO_FORGET_CASCADE)는 지운 파편을 source_fragment_id 로 가진 행의 요약을
-- 바꾸고, scripts/purge-orphan-case-summaries.js 는 원본 파편이 없는 행을 찾는다. 두 경로가 쓰는
-- 조회 색인이다. source_fragment_id 가 없는 행은 색인하지 않는다.
-- 운영 DB는 scripts/ops/online-index.mjs 로 먼저 만든다(scripts/ops/index-manifest.json).
-- 아래 IF NOT EXISTS 문은 이미 만든 색인을 건너뛴다(docs/operations/online-migration.md).

SET LOCAL lock_timeout = '3s';

CREATE INDEX IF NOT EXISTS idx_ce_source_fragment_id
    ON agent_memory.case_events (source_fragment_id) WHERE source_fragment_id IS NOT NULL;
