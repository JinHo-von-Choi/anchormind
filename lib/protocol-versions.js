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

/**
 * 2026-07-28 이후 개정에서 요청마다 params._meta에 싣는 프로토콜 버전 키.
 * 이 서버는 해당 개정을 구현하지 않으며 요청 분류에만 쓴다.
 */
export const PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";
