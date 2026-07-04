-- migration-020-search-layer-latency.sql
-- 검색 이벤트에 레이어별 레이턴시 컬럼 추가
-- 경로별 성능 집계(L1/L2/L3 소요시간, RRF 여부, 그래프 사용 여부) 지원
--
-- 실행: psql $DATABASE_URL -f lib/memory/migration-020-search-layer-latency.sql

ALTER TABLE agent_memory.search_events
  ADD COLUMN IF NOT EXISTS l1_latency_ms REAL,
  ADD COLUMN IF NOT EXISTS l2_latency_ms REAL,
  ADD COLUMN IF NOT EXISTS l3_latency_ms REAL,
  ADD COLUMN IF NOT EXISTS rrf_used      BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS graph_used    BOOLEAN DEFAULT false;
