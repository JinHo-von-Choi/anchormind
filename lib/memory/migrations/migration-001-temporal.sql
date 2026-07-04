/**
 * Migration 001 - Temporal Schema (Point-in-time Query)
 *
 * 작성자: 최진호
 * 작성일: 2026-03-03
 *
 * fragments 테이블에 bi-temporal valid_from / valid_to 컬럼을 추가하여
 * Point-in-time 쿼리(특정 시점의 파편 상태 조회)를 지원한다.
 *
 * - valid_from: 파편이 유효해진 시점 (기본값 NOW())
 * - valid_to  : 파편이 만료된 시점 (NULL = 현재 유효)
 * - superseded_by: 이 파편을 대체한 파편 ID
 */


ALTER TABLE agent_memory.fragments
    ADD COLUMN IF NOT EXISTS valid_from    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS valid_to      TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS superseded_by TEXT REFERENCES agent_memory.fragments(id);

/**
 * 기존 데이터 보정: valid_from을 created_at으로 역보정.
 * created_at은 항상 올바른 값이므로 조건 없이 전체 행에 적용한다.
 * ALTER TABLE과 UPDATE 사이의 시간 경과로 인한 누락을 방지.
 */
UPDATE agent_memory.fragments
SET valid_from = created_at;

/**
 * Temporal Active 인덱스: agent_id + valid_from 복합, valid_to IS NULL 부분 인덱스.
 * 현재 유효한 파편(valid_to IS NULL) 대상 쿼리를 최적화.
 */
CREATE INDEX IF NOT EXISTS idx_fragments_temporal_active
    ON agent_memory.fragments (agent_id, valid_from)
    WHERE valid_to IS NULL;

/**
 * valid_from 단순 인덱스: Point-in-time 범위 쿼리 지원.
 */
CREATE INDEX IF NOT EXISTS idx_fragments_valid_from
    ON agent_memory.fragments (valid_from);

/**
 * valid_to 인덱스: 만료 파편 쿼리 지원.
 */
CREATE INDEX IF NOT EXISTS idx_fragments_valid_to
    ON agent_memory.fragments (valid_to)
    WHERE valid_to IS NOT NULL;

/**
 * Partial Unique Index: 동일 id로 valid_to IS NULL인 행은 최대 1개.
 *
 * 주의: 기존 데이터에 동일 id × valid_to IS NULL이 복수 존재하면 인덱스 생성 실패.
 * 이 마이그레이션에서 valid_to 컬럼이 신규 추가되므로 기존 모든 행의 valid_to = NULL.
 * 그러나 id는 PRIMARY KEY(UNIQUE)이므로 id 중복은 이미 불가능 → 인덱스 생성 안전.
 */
CREATE UNIQUE INDEX IF NOT EXISTS idx_fragments_one_active_per_id
    ON agent_memory.fragments (id)
    WHERE valid_to IS NULL;

