/**
 * 공통 유틸리티 — CORS, 워커 참조 저장소, Consolidator 실행 기록
 *
 * 작성자: 최진호
 * 작성일: 2026-04-04
 */

import { ALLOWED_ORIGINS, OAUTH_TRUSTED_ORIGINS, STRICT_ORIGIN } from "../config.js";
import { readCorsMode } from "../env-parse.js";
import { logInfo } from "../logger.js";

/**
 * 워커 참조 저장소 — server.js에서 setWorkerRefs()로 주입
 *
 * embeddingWorkerRef는 { current: EmbeddingWorker|null } 형태의 참조 객체를 받아
 * 비동기 초기화 후에도 최신 인스턴스에 접근할 수 있도록 한다.
 */
export const workerRefs = {
  embeddingWorkerRef: null,
  lastConsolidateRun: null
};

/**
 * 외부에서 워커 참조를 주입하는 setter
 * @param {object} refs
 * @param {object|null} refs.embeddingWorkerRef - { current: EmbeddingWorker|null } 참조 객체
 */
export function setWorkerRefs(refs) {
  if (refs.embeddingWorkerRef !== undefined) workerRefs.embeddingWorkerRef = refs.embeddingWorkerRef;
}

/**
 * Consolidator 마지막 실행 시각을 기록 — scheduler.js에서 호출
 */
export function recordConsolidateRun() {
  workerRefs.lastConsolidateRun = new Date().toISOString();
}

/** observe 모드에서 기록한 Origin. 프로세스당 상한까지만 보관한다 */
const OBSERVED_ORIGIN_LIMIT = 256;
const observedOrigins       = new Set();

/**
 * ALLOWED_ORIGINS가 비었을 때의 응답 방식. 호출 시점의 MEMENTO_CORS_MODE를 읽는다.
 * reflect: 요청 Origin을 그대로 돌려준다.
 * observe(기본): reflect와 같고, 처음 본 Origin을 한 번 기록한다.
 * allowlist: OAUTH_TRUSTED_ORIGINS에 있는 Origin만 돌려준다.
 */
function corsMode() {
  return readCorsMode(process.env);
}

/**
 * 처음 본 교차 출처 Origin을 기록한다. 값은 128자로 자르고 상한을 넘으면 기록하지 않는다.
 */
function noteOrigin(origin) {
  if (observedOrigins.has(origin) || observedOrigins.size >= OBSERVED_ORIGIN_LIMIT) return;
  observedOrigins.add(origin);
  logInfo(`[CORS] cross-origin request from ${String(origin).slice(0, 128)}`);
}

/**
 * Access-Control-Allow-Origin과 Vary를 설정한다.
 * Origin이 없으면 *, ALLOWED_ORIGINS가 있으면 목록에 있는 Origin만, 없으면 corsMode()를 따른다.
 * 허용하지 않는 Origin에는 헤더를 붙이지 않는다.
 */
export function applyCorsOrigin(req, res) {
  const origin = req.headers.origin;

  if (!origin) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    return;
  }
  res.setHeader("Vary", "Origin");

  let allowed;
  if (ALLOWED_ORIGINS.size > 0) {
    allowed = ALLOWED_ORIGINS.has(origin);
  } else {
    const mode = corsMode();
    if (mode === "observe") noteOrigin(origin);
    allowed = mode !== "allowlist" || OAUTH_TRUSTED_ORIGINS.includes(origin);
  }

  if (allowed) res.setHeader("Access-Control-Allow-Origin", origin);
}

/**
 * Origin 헤더 허용 여부 검증 (DNS rebinding 방어)
 *
 * MCP_STRICT_ORIGIN=true 인 경우에만 적용 (opt-in).
 * - Origin 헤더 없음(CLI/curl): 항상 허용
 * - STRICT_ORIGIN=false(기본): 항상 허용 (기존 동작 유지)
 * - STRICT_ORIGIN=true: 허용 목록(신뢰 도메인 + ALLOWED_ORIGINS)에 있는 Origin만 허용
 *
 * @param {import("node:http").IncomingMessage} req
 * @returns {boolean}
 */
export function isOriginAllowed(req) {
  const origin = req.headers.origin;
  if (!origin)        return true;
  if (!STRICT_ORIGIN) return true;

  const allowlist = new Set([
    "https://claude.ai",
    "https://chatgpt.com",
    "https://platform.openai.com",
    ...OAUTH_TRUSTED_ORIGINS,
    ...ALLOWED_ORIGINS
  ]);

  return allowlist.has(origin);
}
