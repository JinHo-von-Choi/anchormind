/*
 * migration-034-v2.16.0-bundle.sql
 *
 * 작성자: 최진호
 * 작성일: 2026-04-18
 * 수정일: 2026-04-21 (v2.16.0 릴리즈용 통합 — 034/035/036 단일 파일 병합)
 *
 * 이 파일은 GitHub origin/main 이후 도입된 3개 마이그레이션을 단일 파일로
 * 병합한 것이다. 각 섹션은 원본 마이그레이션의 의미를 보존하며 독립적으로
 * IF NOT EXISTS 가드를 사용하여 재실행 안전하다.
 *
 *   1. api_keys.default_mode  — Mode preset 시스템(recall-only / write-only /
 *                               onboarding / audit) 키별 기본값. NULL이면 전체 도구 노출.
 *   2. fragments.affect       — 정서 태그. neutral/frustration/confidence/
 *                               surprise/doubt/satisfaction. 기본값 'neutral'.
 *   3. fragments.idempotency_key + partial unique 인덱스 2종
 *                              — 클라이언트 재시도 시 중복 파편 생성 방지.
 *                                tenant(key_id NOT NULL) / master(key_id NULL)
 *                                각 범위 내 유일성 별도 인덱스로 보장.
 *
 * 주의: CREATE INDEX CONCURRENTLY는 트랜잭션 내 실행 불가.
 *   migration runner(scripts/migrate.js)가 BEGIN/COMMIT으로 감싸므로
 *   일반 CREATE UNIQUE INDEX를 사용한다. 프로덕션 대규모 테이블에서 잠금
 *   최소화가 필요하면 migrate.js 실행 전 해당 문을 수동 CONCURRENTLY로
 *   선행 실행하고, 본 파일은 IF NOT EXISTS 가드로 안전하게 skip된다.
 *
 * 멱등: 모든 DDL에 IF NOT EXISTS 가드.
 */

SET search_path TO agent_memory;


/* ─────────────────────────────────────────────────────────────────
 * 1) api_keys.default_mode (Mode preset 시스템)
 *    원본: migration-034-api-key-mode.sql (2026-04-18)
 * ───────────────────────────────────────────────────────────────── */

ALTER TABLE agent_memory.api_keys
  ADD COLUMN IF NOT EXISTS default_mode TEXT;

CREATE INDEX IF NOT EXISTS idx_api_keys_default_mode
  ON agent_memory.api_keys(default_mode)
  WHERE default_mode IS NOT NULL;

/* ─────────────────────────────────────────────────────────────────
 * 2) fragments.affect (정서 태그)
 *    원본: migration-035-affect.sql (2026-04-18)
 * ───────────────────────────────────────────────────────────────── */

ALTER TABLE agent_memory.fragments
  ADD COLUMN IF NOT EXISTS affect TEXT
    CHECK (affect IN ('neutral', 'frustration', 'confidence', 'surprise', 'doubt', 'satisfaction'))
    DEFAULT 'neutral';

CREATE INDEX IF NOT EXISTS idx_frag_affect
  ON agent_memory.fragments(affect)
  WHERE affect IS NOT NULL AND affect != 'neutral';

COMMENT ON COLUMN agent_memory.fragments.affect IS
  '정서 태그. neutral/frustration/confidence/surprise/doubt/satisfaction 중 하나. 기본값 neutral.';

/* ─────────────────────────────────────────────────────────────────
 * 3) fragments.idempotency_key + tenant/master partial unique 인덱스
 *    원본: migration-036-fragment-idempotency.sql (2026-04-20)
 * ───────────────────────────────────────────────────────────────── */

ALTER TABLE agent_memory.fragments
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT NULL;

/* DB API key(key_id IS NOT NULL) 전용 복합 partial unique index */
CREATE UNIQUE INDEX IF NOT EXISTS idx_fragments_idempotency_tenant
  ON agent_memory.fragments (key_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL AND key_id IS NOT NULL;

/* master(key_id IS NULL) 전용 partial unique index */
CREATE UNIQUE INDEX IF NOT EXISTS idx_fragments_idempotency_master
  ON agent_memory.fragments (idempotency_key)
  WHERE idempotency_key IS NOT NULL AND key_id IS NULL;

