-- migration-076-search-events-autovacuum.sql
--
-- 작성자: 최진호
-- 작성일: 2026-11-04
--
-- search_events는 recall마다 행이 쌓이고 정리 주기가 30일 지난 행을 지운다(ConsolidatorGC._gcSearchEvents).
-- 지운 행은 autovacuum이 치워야 공간이 재사용되는데, 기본 임계값(죽은 행이 전체의 20%)에서는 30만 행 표가
-- 죽은 행 6만 개를 넘어야 돌아 표가 계속 커진다. 이 표만 임계값을 5%로 낮춘다.
-- 표 설정만 바꾸며 잠금은 짧다(SHARE UPDATE EXCLUSIVE). 같은 값을 다시 써도 되므로 멱등이다.

SET LOCAL lock_timeout = '3s';

ALTER TABLE agent_memory.search_events SET (
  autovacuum_vacuum_scale_factor  = 0.05,
  autovacuum_analyze_scale_factor = 0.05
);
