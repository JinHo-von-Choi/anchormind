/**
 * SyntheticQueryGenerator - 파편 역질의 생성
 *
 * 작성자: 최진호
 * 작성일: 2026-08-28
 *
 * 저장된 파편을 나중에 회상할 때 던져질 만한 질문을 생성한다. 본문 임베딩만으로는
 * 저장 표기와 회상 표기가 어긋날 때 후보 진입에 실패한다. 실측에서 영문 기술용어가
 * 섞인 저장문과 한국어 질의의 코사인이 0.26 부근이었고, 이는 임의 파편 대비 분포의
 * 중앙값(0.228)과 거의 구분되지 않는 수준이다.
 *
 * 생성은 기존 LLM 체인(lib/llm/index.js)에 위임한다. 별도 provider나 키를 두지 않는다.
 */

import { MEMORY_CONFIG } from "../../../config/memory.js";
import { logWarn }       from "../../logger.js";

/** 한국어 본문에 섞이면 안 되는 문자대. 한자와 가나가 들어오면 생성 언어가 흔들린 것이다. */
const HAN_OR_KANA = /[\u3040-\u30FF\u4E00-\u9FFF]/;

const SYSTEM_PROMPT = [
  "너는 장기 기억 시스템의 색인 보조자다.",
  "주어진 기억 파편을 나중에 회상할 때 사용자가 던질 만한 질문을 생성한다.",
  "",
  "규칙:",
  "1. 질문은 한국어 구어체로 쓴다. 실제 사용자가 검색창에 칠 법한 표현이어야 한다.",
  "2. 원문에 등장하는 고유명사, 식별자, 수치를 최소 하나는 그대로 보존한다.",
  "3. 원문을 그대로 베끼지 않는다. 표현을 바꾸되 가리키는 대상은 같아야 한다.",
  "4. 서로 다른 각도의 질문을 만든다. 같은 질문의 어미만 바꾼 것은 하나로 친다.",
  "5. 원문에 없는 사실을 지어내지 않는다.",
  "",
  'JSON만 출력한다. 형식: {"queries": ["질문1", "질문2"]}',
].join("\n");

/**
 * 문자열에서 고유명사 후보 토큰을 뽑는다.
 * 보존 검증용이며 형태소 분석 없이 표기 특징만 본다.
 *
 * @param {string} text
 * @returns {Set<string>}
 */
export function extractAnchorTokens(text) {
  const value  = String(text ?? "");
  const tokens = new Set();

  const patterns = [
    /[A-Za-z][A-Za-z0-9_.-]{2,}/g,          // 영문 식별자·제품명
    /\d+(?:\.\d+)?(?:ms|s|m|h|d|kb|mb|gb|%)?/gi, // 수치
    /\/[A-Za-z0-9._\-/]+/g,                 // 경로
  ];

  for (const pattern of patterns) {
    for (const raw of value.match(pattern) || []) {
      const token = raw.toLowerCase();
      if (token.length < 2) continue;
      tokens.add(token);
    }
  }
  return tokens;
}

/**
 * 생성된 질의가 채택 가능한지 판정한다.
 *
 * @param {string} query
 * @param {string} sourceContent
 * @param {{maxQueryChars?: number, requireAnchor?: boolean}} [opts]
 * @returns {{accept: boolean, reason: string|null}}
 */
export function validateQuery(query, sourceContent, opts = {}) {
  const maxChars      = opts.maxQueryChars ?? MEMORY_CONFIG.syntheticQuery?.maxQueryChars ?? 120;
  const requireAnchor = opts.requireAnchor !== false;

  const text = String(query ?? "").trim();
  if (text.length === 0)          return { accept: false, reason: "empty" };
  if (text.length > maxChars)     return { accept: false, reason: "too_long" };

  const source = String(sourceContent ?? "").trim();
  if (text === source)            return { accept: false, reason: "verbatim_copy" };

  /** 원문에 없던 한자·가나가 질의에 들어오면 생성 언어가 흔들린 것으로 보고 버린다. */
  if (HAN_OR_KANA.test(text) && !HAN_OR_KANA.test(source)) {
    return { accept: false, reason: "language_drift" };
  }

  if (requireAnchor) {
    const sourceAnchors = extractAnchorTokens(source);
    if (sourceAnchors.size > 0) {
      const queryAnchors = extractAnchorTokens(text);
      const preserved    = [...queryAnchors].some(t => sourceAnchors.has(t));
      if (!preserved) return { accept: false, reason: "anchor_lost" };
    }
  }

  return { accept: true, reason: null };
}

/**
 * 질의 목록에서 중복과 부적합 항목을 걸러 채택분만 남긴다.
 *
 * @param {string[]} queries
 * @param {string}   sourceContent
 * @param {{maxQueries?: number}} [opts]
 * @returns {{accepted: string[], rejected: Array<{query: string, reason: string}>}}
 */
export function filterQueries(queries, sourceContent, opts = {}) {
  const maxQueries = opts.maxQueries ?? MEMORY_CONFIG.syntheticQuery?.maxQueries ?? 3;
  const accepted   = [];
  const rejected   = [];
  const seen       = new Set();

  for (const raw of Array.isArray(queries) ? queries : []) {
    if (accepted.length >= maxQueries) break;

    const text = String(raw ?? "").trim();
    const norm = text.toLowerCase().replace(/\s+/g, " ");
    if (seen.has(norm)) {
      rejected.push({ query: text, reason: "duplicate" });
      continue;
    }

    const verdict = validateQuery(text, sourceContent, opts);
    if (!verdict.accept) {
      rejected.push({ query: text, reason: verdict.reason });
      continue;
    }

    seen.add(norm);
    accepted.push(text);
  }

  return { accepted, rejected };
}

/**
 * 파편이 역질의 생성 대상인지 판정한다.
 *
 * @param {{type?: string, importance?: number}} fragment
 * @param {Object} [cfg]
 * @returns {boolean}
 */
export function isEligible(fragment, cfg = MEMORY_CONFIG.syntheticQuery || {}) {
  if (!fragment) return false;
  if (cfg.enabled === false) return false;

  const minImportance = cfg.minImportance ?? 0.8;
  const types         = Array.isArray(cfg.types) ? cfg.types : null;

  if (typeof fragment.importance === "number" && fragment.importance < minImportance) return false;
  if (types && fragment.type && !types.includes(fragment.type)) return false;
  return true;
}

/**
 * 파편 본문으로부터 역질의를 생성한다.
 *
 * 생성 실패는 호출자에게 예외를 전파하지 않고 빈 배열로 돌려준다.
 * 이 경로의 실패가 파편 저장이나 검색에 영향을 주어서는 안 된다.
 *
 * @param {string} content
 * @param {{timeoutMs?: number, maxQueries?: number, llm?: Function}} [opts]
 * @returns {Promise<{queries: string[], rejected: Array<{query: string, reason: string}>}>}
 */
export async function generateQueries(content, opts = {}) {
  const cfg       = MEMORY_CONFIG.syntheticQuery || {};
  const timeoutMs = opts.timeoutMs ?? cfg.llmTimeoutMs ?? 20000;

  const source = String(content ?? "").trim();
  if (source.length === 0) return { queries: [], rejected: [] };

  /** LLM 체인은 이 함수 안에서만 필요하다. 정적 import로 두면 remember 후처리 경로가
   *  LLM 스택 전체를 끌어들여 기동 비용과 의존 그래프가 불필요하게 커진다. */
  let call = opts.llm;
  if (typeof call !== "function") {
    try {
      ({ llmJson: call } = await import("../../llm/index.js"));
    } catch (err) {
      logWarn(`[SyntheticQueryGenerator] LLM 모듈 로드 실패: ${err.message}`);
      return { queries: [], rejected: [] };
    }
  }

  const userPrompt = [
    `기억 파편: ${source}`,
    "",
    `이 파편을 회상할 때 던질 만한 질문을 ${cfg.minQueries ?? 2}개에서 ${cfg.maxQueries ?? 3}개 만들어라.`,
  ].join("\n");

  let raw;
  try {
    raw = await call(userPrompt, { timeoutMs, systemPrompt: SYSTEM_PROMPT });
  } catch (err) {
    logWarn(`[SyntheticQueryGenerator] LLM 호출 실패: ${err.message}`);
    return { queries: [], rejected: [] };
  }

  const queries = Array.isArray(raw?.queries) ? raw.queries
                : Array.isArray(raw)          ? raw
                : [];

  const { accepted, rejected } = filterQueries(queries, source, opts);
  return { queries: accepted, rejected };
}
