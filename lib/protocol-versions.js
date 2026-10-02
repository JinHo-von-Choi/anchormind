/**
 * MCP 프로토콜 버전 상수
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */

/**
 * 지원하는 MCP 프로토콜 버전 목록 (최신순)
 * - 2024-11-05: 초기 릴리스 (인증 모델 미포함)
 * - 2025-03-26: OAuth 2.1 인증, Streamable HTTP 도입
 * - 2025-06-18: 구조화된 도구 출력, 서버 주도 상호작용
 * - 2025-11-25: Tasks 추상화, 장기 실행 작업 지원
 */
export const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05"
];

export const DEFAULT_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];
