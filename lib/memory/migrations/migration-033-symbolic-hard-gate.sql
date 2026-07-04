/*
 * migration-033-symbolic-hard-gate.sql
 *
 * 작성자: 최진호
 * 작성일: 2026-04-15
 *
 * Phase 4 soft gating을 테넌트별로 hard gate로 승격할 수 있는 opt-in 플래그.
 * 기본값 false — 기존 동작과 동일. true로 설정된 API 키에 한해
 * PolicyRules 위반이 remember 차단으로 전환될 수 있다 (Phase 4 정책 결정 이후).
 *
 * 안전 원칙:
 * - 기본값 false (회귀 0건)
 * - IF NOT EXISTS로 재실행 안전
 * - 기존 api_keys 행 전부에 false 자동 적용
 */

ALTER TABLE agent_memory.api_keys
  ADD COLUMN IF NOT EXISTS symbolic_hard_gate BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN agent_memory.api_keys.symbolic_hard_gate
  IS 'Phase 4 symbolic gating: true이면 PolicyRules 위반 시 remember 차단 (Phase 4 정책 결정 후 활성화). 기본 false = soft warning only.';
