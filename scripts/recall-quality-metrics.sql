-- recall-quality-metrics.sql
-- 작성자: 최진호
-- 작성일: 2026-07-16
-- 사용: psql "$DATABASE_URL" -f scripts/recall-quality-metrics.sql

SET search_path TO agent_memory;

-- (1) morpheme_indexed 비율 (전체 대비 인덱싱 완료)
SELECT
  count(*)                                            AS total,
  count(*) FILTER (WHERE morpheme_indexed)            AS indexed,
  round(100.0 * count(*) FILTER (WHERE morpheme_indexed) / NULLIF(count(*), 0), 2) AS indexed_pct
FROM fragments;

-- (2) 최근 30일 생성분 morpheme_indexed 비율 (신규 파편 공백 추적)
SELECT
  count(*)                                            AS recent_total,
  count(*) FILTER (WHERE morpheme_indexed)            AS recent_indexed,
  round(100.0 * count(*) FILTER (WHERE morpheme_indexed) / NULLIF(count(*), 0), 2) AS recent_indexed_pct
FROM fragments
WHERE created_at >= NOW() - INTERVAL '30 days';

-- (3) keywords 오염률: 조사 잔존 토큰을 포함한 파편 비율
--     한글 토큰이 대표 조사로 끝나는 keyword를 오염으로 간주
SELECT
  count(*)                                            AS total,
  count(*) FILTER (
    WHERE EXISTS (
      SELECT 1 FROM unnest(keywords) AS k
      WHERE k ~ '[가-힣](를|을|는|은|이|가|의|에|로|도|와|과|만|까지|부터|에서|에게|으로|라는|에는)$'
    )
  )                                                   AS polluted,
  round(100.0 * count(*) FILTER (
    WHERE EXISTS (
      SELECT 1 FROM unnest(keywords) AS k
      WHERE k ~ '[가-힣](를|을|는|은|이|가|의|에|로|도|와|과|만|까지|부터|에서|에게|으로|라는|에는)$'
    )
  ) / NULLIF(count(*), 0), 2)                         AS polluted_pct
FROM fragments
WHERE keywords IS NOT NULL;

-- (4) session_reflect permanent 적재율 (P4 효과)
SELECT
  count(*)                                            AS reflect_total,
  count(*) FILTER (WHERE ttl_tier = 'permanent')      AS reflect_permanent,
  round(100.0 * count(*) FILTER (WHERE ttl_tier = 'permanent') / NULLIF(count(*), 0), 2) AS permanent_pct
FROM fragments
WHERE topic = 'session_reflect';

-- (5) SearchParamAdaptor 하향 잔존 행 (P5c 효과)
SELECT count(*) AS below_default
FROM search_param_thresholds
WHERE min_similarity < 0.5;
