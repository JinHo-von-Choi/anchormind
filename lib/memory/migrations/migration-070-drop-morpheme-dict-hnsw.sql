-- migration-070-drop-morpheme-dict-hnsw.sql
--
-- 작성자: 최진호
-- 작성일: 2026-10-22
--
-- morpheme_dict는 형태소 키로만 조회한다(morpheme = ANY(...)). 형태소 벡터는 그 값을 읽어 앱에서
-- 평균을 내는 데만 쓰이고 벡터 거리로 찾는 질의가 없어 HNSW 색인은 조회에 쓰이지 않는다.
-- 색인은 형태소를 넣을 때마다 갱신 비용만 든다. 색인을 지운다.
-- 다른 질의가 잡은 잠금을 오래 기다리지 않게 lock_timeout을 둔다. 시간 안에 못 잡으면 실패하고
-- 적용 이력에 남지 않으므로 다시 실행한다.
-- 멱등: DROP INDEX IF EXISTS

SET LOCAL lock_timeout = '5s';

DROP INDEX IF EXISTS agent_memory.idx_morpheme_dict_embedding;
