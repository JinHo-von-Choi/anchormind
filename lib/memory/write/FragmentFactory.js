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
import { sanitizeAffect }             from "./FragmentWriter.js";

const MAX_FRAGMENT_LENGTH         = 300;
const MAX_EPISODE_FRAGMENT_LENGTH = 1000;

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
 */
export function countTokens(text) {
  const enc = getTokenEncoder();
  if (enc) {
    return enc.encode(text).length;
  }
  return Math.ceil(text.length / 4);
}

/**
 * 키워드 배열을 소문자로 정규화한다. 키워드 저장 경로의 단일 출처.
 *
 * @param {string[]} keywords
 * @returns {string[]}
 */
export function normalizeKeywords(keywords) {
  return keywords.map(k => k.toLowerCase());
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
     * @returns {Object} fragment
     */
  create(params) {
    const rawContent = (params.content || "").trim();
    if (!rawContent) throw new Error("Fragment content is required");

    const validation = FragmentFactory.validateContent(
      rawContent,
      params.type ?? null,
      params.topic ?? null
    );
    if (!validation.valid) throw new Error(validation.reason);

    /** PII(개인정보) 마스킹 처리 */
    const redactedContent = this._redactPII(rawContent);

    const maxLen    = params.type === "episode" ? MAX_EPISODE_FRAGMENT_LENGTH : MAX_FRAGMENT_LENGTH;
    const truncated = redactedContent.length > maxLen
      ? `${redactedContent.substring(0, maxLen)}...`
      : redactedContent;

    const type       = params.type || "fact";
    const importance = params.importance ?? (IMPORTANCE_WEIGHT[type] || 0.5);
    const keywords   = params.keywords && params.keywords.length > 0
      ? normalizeKeywords(params.keywords)
      : this.extractKeywords(truncated);

    return {
      id               : this.generateId(),
      content          : truncated,
      topic            : params.topic || "general",
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
   * PII(개인정보) 탐지 및 마스킹
   * 대상: API Key, Email, 비밀번호 패턴, 전화번호 등
   */
  _redactPII(text) {
    let redacted = text;

    /** 1. API Keys (OpenAI, Google 등 일반적인 패턴) */
    redacted = redacted.replace(/(sk-[a-zA-Z0-9]{32,}|AIza[0-9A-Za-z-_]{35})/g, "[REDACTED_API_KEY]");

    /** 2. 이메일 */
    redacted = redacted.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, "[REDACTED_EMAIL]");

    /** 3. 비밀번호 필드 패턴 */
    redacted = redacted.replace(/(password|passwd|pwd|비밀번호|비번)\s*[:=]\s*[^\s,]+/gi, (match, p1) => `${p1}: [REDACTED_PWD]`);

    /** 4. 한국 휴대전화 번호 */
    redacted = redacted.replace(/01[016789][-\s]?\d{3,4}[-\s]?\d{4}/g, "[REDACTED_PHONE]");

    return redacted;
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
