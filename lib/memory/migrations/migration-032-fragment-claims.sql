-- migration-032-fragment-claims.sql
-- v2.8.0 Symbolic Memory Phase 0: fragment_claims 테이블
-- 작성자: 최진호
-- 작성일: 2026-04-15
--
-- 목적: Neurosymbolic 기억 시스템의 정규화된 claim 저장소
--       (subject, predicate, object, polarity) 튜플 + tenant 격리
--
-- 참조: migration-031-content-hash-per-key.sql 패턴 (master NULL / tenant 분리 partial unique 2개)
--
-- 주의사항:
--   1) fragments.key_id 와 fragments.id 모두 TEXT 타입 (migration-004 + 실측 확인).
--      fragment_claims.key_id / fragment_id 모두 TEXT 로 맞춰야 FK 의미론 일치.
--      fragment_id 에 UUID 사용 시 타입 불일치로 FK 제약 실패함.
--   2) ClaimStore.insert 는 fragment_claims.key_id 가 fragments.key_id 와 일치하는지
--      write-time 에 확인. 위반 시 memento_tenant_isolation_blocked_total 카운터 증가.
--   3) master(NULL) / tenant(TEXT) 분리 partial unique 인덱스로 ON CONFLICT 경로에서
--      크로스 테넌트 누출 차단.
--   4) Phase 3 advisory warning 을 위해 fragments.validation_warnings JSONB 컬럼 추가.
--
-- 멱등: IF EXISTS / IF NOT EXISTS 가드 사용
-- 롤백: migration-032-rollback.sql


-- 1) fragment_claims 테이블 생성
CREATE TABLE IF NOT EXISTS agent_memory.fragment_claims (
    id             BIGSERIAL PRIMARY KEY,
    fragment_id    TEXT NOT NULL REFERENCES agent_memory.fragments(id) ON DELETE CASCADE,
    key_id         TEXT NULL,
    subject        TEXT NOT NULL,
    predicate      TEXT NOT NULL,
    object         TEXT NULL,
    polarity       TEXT NOT NULL CHECK (polarity IN ('positive', 'negative', 'uncertain')),
    confidence     REAL NOT NULL DEFAULT 0.5 CHECK (confidence BETWEEN 0.0 AND 1.0),
    extractor      TEXT NOT NULL CHECK (extractor IN ('morpheme-rule', 'llm', 'manual')),
    rule_version   TEXT NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2) 조회 인덱스: polarity 충돌 탐지 쿼리의 핵심 경로
--    WHERE key_id IS NOT DISTINCT FROM $1 AND subject = $2 AND predicate = $3
CREATE INDEX IF NOT EXISTS idx_fragment_claims_key_subject_pred
    ON agent_memory.fragment_claims(key_id, subject, predicate);

-- 3) fragment_id 역조회 인덱스 (FK CASCADE + ClaimStore.deleteByFragment)
CREATE INDEX IF NOT EXISTS idx_fragment_claims_fragment
    ON agent_memory.fragment_claims(fragment_id);

-- 4) 중복 방지 partial unique 인덱스 2개 (migration-031 패턴)
--    master(NULL) 전용: 하나의 fragment 에 동일 (subject, predicate, object) 중복 금지
CREATE UNIQUE INDEX IF NOT EXISTS uq_fragment_claims_master
    ON agent_memory.fragment_claims(fragment_id, subject, predicate, COALESCE(object, ''))
    WHERE key_id IS NULL;

-- 5) tenant(TEXT) 전용 복합 partial unique
CREATE UNIQUE INDEX IF NOT EXISTS uq_fragment_claims_tenant
    ON agent_memory.fragment_claims(key_id, fragment_id, subject, predicate, COALESCE(object, ''))
    WHERE key_id IS NOT NULL;

-- 6) fragments.validation_warnings JSONB 컬럼 (Phase 3 advisory warning 저장)
--    예: [{"code": "polarity_conflict", "severity": "high", "evidence": "..."}]
ALTER TABLE agent_memory.fragments
    ADD COLUMN IF NOT EXISTS validation_warnings JSONB NULL;

