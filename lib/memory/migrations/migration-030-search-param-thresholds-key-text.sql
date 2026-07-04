-- migration-030-search-param-thresholds-key-text.sql
-- 작성자: 최진호
-- 목적: search_param_thresholds.key_id 타입을 INTEGER에서 TEXT로 변경.
-- 사유: fragments.key_id는 migration-027부터 TEXT(UUID). SearchParamAdaptor가
--       런타임에서 INTEGER 캐스팅 실패로 적응형 학습 무력화. UUID 호환을 위해
--       TEXT로 통일. sentinel -1 (마스터 키) → '-1' 로 문자열 보존.


-- key_id INTEGER NOT NULL DEFAULT -1 → TEXT NOT NULL DEFAULT '-1'
-- USING key_id::text 로 기존 INTEGER 데이터 무손실 변환
ALTER TABLE agent_memory.search_param_thresholds
    ALTER COLUMN key_id TYPE TEXT USING key_id::text;

-- DEFAULT 값도 TEXT 리터럴로 갱신 (캐스팅 후 DEFAULT는 자동 변환되지 않음)
ALTER TABLE agent_memory.search_param_thresholds
    ALTER COLUMN key_id SET DEFAULT '-1';

