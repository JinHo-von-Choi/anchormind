-- migration-029-search-param-thresholds.sql
-- SearchParamAdaptor용 검색 파라미터 학습 테이블
--
-- key_id x query_type x hour_bucket 조합별 minSimilarity를 온라인 학습한다.
-- sample_count >= 50 이전까지는 기본값(config/memory.js)을 사용한다.
--
-- key_id = -1 은 마스터 키 / 전체 기본값을 의미한다 (NULL 사용하지 않음).

CREATE TABLE IF NOT EXISTS agent_memory.search_param_thresholds (
  id                 SERIAL PRIMARY KEY,
  key_id             INTEGER  NOT NULL DEFAULT -1,
  query_type         TEXT     NOT NULL DEFAULT 'text',
  hour_bucket        SMALLINT NOT NULL DEFAULT -1,

  min_similarity     FLOAT    NOT NULL DEFAULT 0.35,

  sample_count       INTEGER  NOT NULL DEFAULT 0,
  total_result_count INTEGER  NOT NULL DEFAULT 0,

  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (key_id, query_type, hour_bucket)
);
