/**
 * FragmentFactory - 파편 자동 생성 및 키워드 추출
 *
 * 작성자: 최진호
 * 작성일: 2026-02-23
 * 수정일: 2026-04-03 (Narrative Reconstruction Phase 1: case_id, goal, outcome, phase, resolution_status, assertion_status 추가)
 * 수정일: 2026-04-18 (migration-034-v2.16.0-bundle: affect 정서 태그 필드 추가)
 *
 * 원시 텍스트를 원자적 파편 단위로 분할하고 메타데이터를 부여
 * js-tiktoken(cl100k_base)으로 정밀 토큰 수 계산
 */

import crypto                          from "crypto";
import { encodingForModel }            from "js-tiktoken";
import { sanitizeAffect }             from "./affect.js";
import { MAX_FRAGMENT_LENGTH, MAX_EPISODE_FRAGMENT_LENGTH } from "../contentGuard.js";
import { maskText }                   from "../../security/SensitiveScanner.js";
import { sensitiveScanEffectiveMode } from "../../config.js";

export { MAX_FRAGMENT_LENGTH, MAX_EPISODE_FRAGMENT_LENGTH };
/** 사용자 지정 keywords와 본문 추출 결과를 병합한 뒤의 상한. 사용자 지정이 앞선다. */
const MAX_MERGED_KEYWORDS         = 10;

let _tokenEncoder = null;

/**
 * cl100k_base 인코더 인스턴스를 지연 로드한다.
 * 초기화 실패 시 문자 수 / 4 근사치로 폴백.
 */
function getTokenEncoder() {
  if (_tokenEncoder) return _tokenEncoder;
  try {
    _tokenEncoder = encodingForModel("gpt-4");
    return _tokenEncoder;
  } catch {
    return null;
  }
}

/**
 * 텍스트의 토큰 수를 cl100k_base로 정밀 계산한다.
 * 인코더 사용 불가 시 chars / 4 근사치 반환.
 *
 * 사용자 본문에 `<|endoftext|>` 같은 특수 토큰 문자열이 있어도 던지지 않는다. 기본 encode는
 * 이를 "not allowed"로 거부해 batch_remember 항목이 저장 실패했다. 특수 토큰 처리를 끄고
 * 일반 텍스트로 센다(allowedSpecial=[], disallowedSpecial=[]).
 */
export function countTokens(text) {
  const enc = getTokenEncoder();
  if (enc) {
    return enc.encode(text, [], []).length;
  }
  return Math.ceil(text.length / 4);
}

/**
 * 키워드 항목을 문자열로 바꾼다. 문자열과 유한한 숫자가 문자열이 되고, 그 밖의 값은 그대로 돌려준다.
 * 저장 경로의 키워드 문자열 변환은 이 함수 하나를 쓴다.
 *
 * @param {unknown} keyword
 * @returns {unknown}
 */
export function keywordText(keyword) {
  if (typeof keyword === "string") return keyword;
  if (typeof keyword === "number" && Number.isFinite(keyword)) return String(keyword);
  return keyword;
}

/**
 * 키워드 배열을 소문자로 정규화한다. 키워드 저장 경로의 단일 출처.
 *
 * @param {string[]} keywords
 * @returns {string[]}
 */
export function normalizeKeywords(keywords) {
  return keywords.map((k, i) => {
    const text = keywordText(k);
    if (typeof text === "string") return text.toLowerCase();
    const err = new Error(`keywords[${i}] must be a string`);
    err.code  = -32602;
    throw err;
  });
}

/**
 * 사용자 지정 키워드와 본문 추출 키워드를 병합한다.
 *
 * 사용자 지정을 우선 배치하고, 대소문자를 무시한 중복을 제거한 뒤
 * MAX_MERGED_KEYWORDS까지 추출 결과로 채운다. 추출 항목은 코드 식별자의
 * 원형을 보존해야 하므로 소문자화하지 않는다.
 *
 * @param {string[]} supplied  정규화된 사용자 지정 키워드
 * @param {string[]} extracted 본문에서 추출한 키워드
 * @returns {string[]}
 */
export function mergeKeywords(supplied, extracted) {
  const merged = [...supplied];
  const seen   = new Set(supplied.map(k => k.toLowerCase()));

  for (const kw of extracted) {
    if (merged.length >= MAX_MERGED_KEYWORDS) break;
    const key = kw.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(kw);
  }

  return merged;
}

const IMPORTANCE_WEIGHT = {
  error     : 0.9,
  decision  : 0.8,
  procedure : 0.7,
  preference: 0.95,
  relation  : 0.6,
  episode   : 0.6,
  fact      : 0.5
};

const URL_ONLY_PATTERN = /^\s*https?:\/\/\S+\s*$/;

/**
 * 본문의 개인정보와 자격 증명 형태를 표식으로 바꾼다. 규칙은 lib/security/sensitivePatterns.js의 표를 쓴다.
 * 탐지 방식이 off(MEMENTO_SENSITIVE_SCAN=off 또는 MEMENTO_WRITE_GATE=off)이면 레거시 규칙만 적용한다.
 *
 * @param {string} text
 * @returns {string}
 */
export function maskSensitiveText(text) {
  return maskText(text, { legacyOnly: sensitiveScanEffectiveMode() === "off" });
}

/**
 * 본문을 유형별 저장 상한으로 자른다. 상한을 넘으면 상한까지 남기고 "..."을 붙인다.
 * 결과를 다시 넣어도 같은 값이 나온다.
 *
 * @param {string}      content
 * @param {string|null} type
 * @returns {string}
 */
export function limitContentLength(content, type) {
  return truncateContent(content, type).value;
}

/**
 * limitContentLength와 같은 절삭을 하되 절삭 여부와 길이를 함께 돌려준다.
 * originalLength는 절삭 직전 본문 길이, storedLength는 끝의 "..."를 포함한 최종 길이다.
 *
 * @param {string}      content
 * @param {string|null} type
 * @returns {{value: string, truncated: boolean, originalLength: number, storedLength: number}}
 */
export function truncateContent(content, type) {
  const maxLen         = type === "episode" ? MAX_EPISODE_FRAGMENT_LENGTH : MAX_FRAGMENT_LENGTH;
  const originalLength = content.length;
  if (originalLength <= maxLen) return { value: content, truncated: false, originalLength, storedLength: originalLength };
  const value = `${content.substring(0, maxLen)}...`;
  return { value, truncated: true, originalLength, storedLength: value.length };
}

export class FragmentFactory {

  /**
   * 파편 내용의 최소 품질을 검증한다.
   *
   * 거부 조건:
   * - content 길이 < 10자 AND 공백 분리 단어 수 < 3
   * - content가 URL만으로 구성 (컨텍스트 없는 링크)
   * - type과 topic이 모두 null/undefined
   *
   * @param {string} content - 원시 텍스트 (trim 이후)
   * @param {string|null} type
   * @param {string|null} topic
   * @returns {{valid: true} | {valid: false, reason: string}}
   */
  static validateContent(content, type, topic) {
    if (content.length < 10 && content.split(/\s+/).filter(Boolean).length < 3) {
      return { valid: false, reason: "Content too short: length < 10 and word count < 3" };
    }
    if (URL_ONLY_PATTERN.test(content)) {
      return { valid: false, reason: "Content is URL-only without context" };
    }
    if (type == null && topic == null) {
      return { valid: false, reason: "Both type and topic are null" };
    }
    return { valid: true };
  }

  /**
   * validateContent가 거부하면 그 사유로 오류를 던진다.
   *
   * @param {string} content - 원시 텍스트 (trim 이후)
   * @param {{type?: string|null, topic?: string|null}} params
   */
  static assertValidContent(content, params) {
    const validation = FragmentFactory.validateContent(content, params.type ?? null, params.topic ?? null);
    if (!validation.valid) throw new Error(validation.reason);
  }

  /**
     * 원시 텍스트에서 단일 파편 생성
     *
     * @param {Object} params
     *   - content          {string}  파편 내용 (1~3문장 권장)
     *   - topic            {string}  주제
     *   - type             {string}  fact|decision|error|preference|procedure|relation
     *   - keywords         {string[]} 선택 - 미입력 시 자동 추출
     *   - importance       {number}  선택 - 미입력 시 type별 기본값
     *   - source           {string}  출처 (세션 ID, 도구명 등)
     *   - linkedTo         {string[]} 연결 파편 ID
     *   - agentId          {string}  에이전트 ID
     *   - caseId           {string}  이 파편이 속한 작업/케이스 식별자
     *   - goal             {string}  에피소드 파편의 목표
     *   - outcome          {string}  에피소드 파편의 결과
     *   - phase            {string}  작업 단계 (예: planning, debugging, verification)
     *   - resolutionStatus {string}  작업 해결 상태 ('open'|'resolved'|'abandoned')
     *   - assertionStatus  {string}  파편의 신뢰도 수준 (기본값 'observed')
     * @param {Object}  [opts]
     * @param {boolean} [opts.contentPrepared] - 본문이 WriteGate 본문 단계(품질 검증, 마스킹, 절삭)를
     *   이미 거쳤다. 품질 검증과 마스킹을 다시 하지 않는다(검증은 마스킹 전 원문에 대해 끝났다).
     *   절삭은 같은 값을 돌려주므로 그대로 둔다.
     * @returns {Object} fragment
     */
  create(params, opts) {
    const rawContent = (params.content || "").trim();
    if (!rawContent) throw new Error("Fragment content is required");

    const prepared = opts?.contentPrepared === true;
    if (!prepared) FragmentFactory.assertValidContent(rawContent, params);

    /** PII(개인정보) 마스킹 처리 */
    const redactedContent = prepared ? rawContent : this._redactPII(rawContent);
    const truncated       = limitContentLength(redactedContent, params.type);

    const type       = params.type || "fact";
    const importance = params.importance ?? (IMPORTANCE_WEIGHT[type] || 0.5);
    /**
     * 사용자가 keywords를 지정해도 본문 추출을 건너뛰지 않는다.
     * 지정만 저장하면 본문에만 등장하는 코드 식별자가 색인되지 않아
     * keywords 배열 교집합을 쓰는 검색 경로에서 회수 자체가 불가능해진다.
     * 사용자 지정을 앞에 두고 중복을 제거한 뒤 상한까지 추출 결과로 채운다.
     */
    const keywords = params.keywords && params.keywords.length > 0
      ? mergeKeywords(normalizeKeywords(params.keywords), this.extractKeywords(truncated))
      : this.extractKeywords(truncated);

    /** topic 앞뒤 공백 정규화 — 공백만 입력되면 기본값으로 강등한다(대소문자는 보존). */
    const topic = (typeof params.topic === "string" ? params.topic.trim() : "") || "general";

    return {
      id               : this.generateId(),
      content          : truncated,
      topic,
      keywords,
      type,
      importance,
      source           : params.source || null,
      linked_to        : params.linkedTo || [],
      agent_id         : params.agentId || "default",
      is_anchor        : params.isAnchor || false,
      ttl_tier         : this._inferTTL(type, importance),
      content_hash     : this._hashContent(truncated),
      estimated_tokens : countTokens(truncated),
      valid_from         : new Date().toISOString(),
      context_summary    : params.contextSummary || null,
      session_id         : params.sessionId || null,
      case_id            : params.caseId || null,
      goal               : params.goal || null,
      outcome            : params.outcome || null,
      phase              : params.phase || null,
      resolution_status  : params.resolutionStatus || null,
      assertion_status   : params.assertionStatus || "observed",
      affect             : sanitizeAffect(params.affect),
      idempotency_key    : params.idempotencyKey ?? null
    };
  }

  /**
   * PII(개인정보)와 자격 증명 마스킹
   * 대상: API 키와 토큰, 개인 키, 이메일, 비밀번호 패턴, 전화번호, 주민등록번호, 카드 번호 등
   */
  _redactPII(text) {
    return maskSensitiveText(text);
  }

  /**
     * 긴 텍스트를 문장 단위로 분할하여 복수 파편 생성
     *
     * @param {string} text - 원본 텍스트
     * @param {Object} meta - 공통 메타데이터 (topic, type, source, agentId)
     * @returns {Object[]} fragments
     */
  splitAndCreate(text, meta = {}) {
    const sentences  = this._splitSentences(text);
    const fragments  = [];
    let buffer       = "";

    for (const sentence of sentences) {
      if ((`${buffer  } ${  sentence}`).trim().length > MAX_FRAGMENT_LENGTH && buffer.length > 0) {
        fragments.push(this.create({
          content : buffer.trim(),
          ...meta
        }));
        buffer = sentence;
      } else {
        buffer = buffer ? `${buffer  } ${  sentence}` : sentence;
      }
    }

    if (buffer.trim().length > 0) {
      fragments.push(this.create({
        content: buffer.trim(),
        ...meta
      }));
    }

    /** 순차 파편 간 자동 링크 */
    for (let i = 1; i < fragments.length; i++) {
      fragments[i].linked_to.push(fragments[i - 1].id);
    }

    return fragments;
  }

  /**
     * 에러 정보를 파편으로 변환
     */
  fromError(errorInfo) {
    const content = [
      errorInfo.message || "Unknown error",
      errorInfo.tool ? `도구: ${errorInfo.tool}` : "",
      errorInfo.resolution ? `해결: ${errorInfo.resolution}` : ""
    ].filter(Boolean).join(". ");

    return this.create({
      content,
      topic    : errorInfo.topic || "error",
      type     : "error",
      keywords : [...(errorInfo.keywords || []), "error", errorInfo.tool].filter(Boolean),
      source   : errorInfo.source || "auto",
      agentId  : errorInfo.agentId
    });
  }

  /**
     * 도구 실행 결과를 파편으로 변환
     */
  fromToolResult(toolName, args, result, agentId) {
    const content = `${toolName} 실행 → ${this._summarizeResult(result)}`;
    const topic   = this._inferTopic(toolName);

    return this.create({
      content,
      topic,
      type     : "fact",
      keywords : [toolName, ...Object.keys(args).slice(0, 3)],
      source   : `tool:${toolName}`,
      agentId
    });
  }

  /**
     * 키워드 자동 추출 (간이 TF 기반)
     */
  extractKeywords(text, maxCount = 5) {
    const stopwords = new Set([
      "이", "그", "저", "것", "수", "등", "및", "를", "을", "에",
      "의", "가", "는", "은", "도", "로", "와", "과", "한", "하",
      "the", "a", "an", "is", "are", "was", "were", "be", "been",
      "have", "has", "had", "do", "does", "did", "will", "would",
      "should", "could", "can", "may", "might", "this", "that",
      "with", "from", "for", "and", "but", "or", "not", "in",
      "on", "at", "to", "of", "it", "its", "by", "as"
    ]);

    /** 한글 토큰 조사·접미 스트리핑 정규식 (긴 접미 우선) */
    const JOSA = /(까지|부터|에서|에게|으로|라는|에는|를|을|는|은|이|가|의|에|로|도|와|과|만)$/;
    /** 코드 식별자: camelCase·PascalCase 또는 snake_case (토큰 경계 전체 매칭) */
    const IDENT = /\b(?:[A-Za-z][a-z0-9]*(?:[A-Z][A-Za-z0-9]*)+|[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+)\b/g;

    /** 1) 코드 식별자 원형을 소문자화 전에 추출하여 우선 확보 */
    const identifiers = [];
    const seenIdent   = new Set();
    for (const m of text.matchAll(IDENT)) {
      const id = m[0];
      if (!seenIdent.has(id)) {
        seenIdent.add(id);
        identifiers.push(id);
      }
    }

    /** 2) 일반 토큰: 소문자화 + 구두점 제거 + 조사 스트리핑 */
    const words = text.toLowerCase()
      .replace(/[^\w\sㄱ-ㅎ가-힣]/g, " ")
      .split(/\s+/)
      .map(w => {
        if (/[가-힣]/.test(w)) {
          const stripped = w.replace(JOSA, "");
          return stripped.length >= 2 ? stripped : w;
        }
        return w;
      })
      .filter(w => w.length > 1 && !stopwords.has(w));

    /** 3) 빈도 계산 후 상위 추출 */
    const freq = new Map();
    for (const w of words) {
      freq.set(w, (freq.get(w) || 0) + 1);
    }
    const ranked = Array.from(freq.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([w]) => w);

    /** 4) 식별자 우선 + 일반 상위 병합, 중복 제거 후 maxCount 절단 */
    const merged = [];
    const seen   = new Set();
    for (const kw of [...identifiers, ...ranked]) {
      const key = kw.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(kw);
      if (merged.length >= maxCount) break;
    }
    return merged;
  }

  /**
     * 고유 ID 생성 (frag-xxx 형식)
     */
  generateId() {
    return `frag-${crypto.randomBytes(8).toString("hex")}`;
  }

  /**
     * TTL 계층 추론
     */
  _inferTTL(type, importance) {
    if (type === "preference")           return "permanent";
    if (importance >= 0.8)               return "permanent";
    if (type === "error" || type === "procedure") return "hot";
    if (type === "episode")              return "warm";
    if (importance >= 0.5)               return "warm";
    return "cold";
  }

  /**
     * 컨텐츠 해시
     */
  _hashContent(content) {
    return crypto.createHash("sha256").update(content).digest("hex").substring(0, 16);
  }

  /**
     * 문장 분할
     */
  _splitSentences(text) {
    return text
      .split(/(?<=[.!?。\n])\s+/)
      .map(s => s.trim())
      .filter(s => s.length > 0);
  }

  /**
     * 결과 요약 (200자 제한)
     */
  _summarizeResult(result) {
    const str = typeof result === "string"
      ? result
      : JSON.stringify(result);
    return str.length > 200 ? `${str.substring(0, 200)  }...` : str;
  }

  /**
     * 도구명에서 토픽 추론
     */
  _inferTopic(toolName) {
    const mapping = {
      db_query        : "database",
      db_tables       : "database",
      db_schema       : "database",
      send_email      : "email",
      list_emails     : "email",
      search_emails   : "email",
      manage_wiki_page: "wiki",
      search_wiki     : "wiki",
      list_docs       : "docs",
      get_doc         : "docs",
      create_doc      : "docs",
      update_doc      : "docs",
      send_sms        : "notification"
    };
    return mapping[toolName] || "tool";
  }
}
