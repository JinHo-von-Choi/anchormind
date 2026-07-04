/**
 * ClaimExtractor — 형태소 기반 polarity 추출 (v2.8.0 Phase 0)
 *
 * 작성자: 최진호
 * 작성일: 2026-04-15
 *
 * 목적: fragment content 를 정규화된 claim(subject, predicate, object, polarity)
 *       트리플로 분해. 1차는 규칙 기반(형태소 + 키워드 매칭), LLM fallback 은
 *       Phase 1 에서 별도 비동기 큐로 적재 예정이며 이 모듈 범위 밖이다.
 *
 * 설계 원칙:
 *  - MorphemeIndex.tokenize 는 async string[] 반환. Gemini CLI 실패 시 fallback 토큰화.
 *  - polarity 판정 우선순위: uncertain > negative > positive (false negative 방지).
 *    negative 마커가 존재하면 positive 마커가 함께 있어도 negative 로 결정.
 *  - content 자체는 소문자화한 원문 문자열에서 키워드 매칭 (형태소 분해 결과는
 *    현 시점엔 subject/predicate/object heuristic 에 한정).
 *  - "사용하지않", "사용하지 않" 처럼 공백 변형을 흡수하기 위해 공백 제거 버전도 함께 검사.
 *  - confidence 는 규칙 기반 extractor 평균 0.5~0.8 범위. 불확실 0.4~0.5.
 *
 * 참조:
 *  - schema: lib/memory/migrations/migration-032-fragment-claims.sql
 */

import { MorphemeIndex } from "../memory/MorphemeIndex.js";

/** positive polarity 마커 — 주장·채택·적용 류 */
const POSITIVE_MARKERS = [
  "사용한다", "사용함", "사용",
  "선호한다", "선호함", "선호",
  "설정한다", "설정함", "설정",
  "채택한다", "채택",
  "활성화한다", "활성화",
  "적용한다", "적용",
  "지원한다", "지원",
  "포함한다", "포함",
  "필수", "권장",
  "use", "uses", "prefer", "prefers",
  "enable", "enabled", "apply", "applies",
  "support", "supports", "adopt", "adopts",
  "required", "recommended"
];

/** negative polarity 마커 — 금지·제거·비활성 류. positive 보다 우선 적용. */
const NEGATIVE_MARKERS = [
  "사용하지않", "사용하지 않",
  "쓰지않", "쓰지 않",
  "금지", "제외",
  "비활성화", "비활성",
  "미지원", "지원하지 않",
  "제거", "삭제",
  "사용 안", "사용안",
  "허용하지 않", "허용하지않",
  "없다", "없음",
  "않음", "않는다", "않습니다",
  "하지 않", "하지않",
  "되지 않", "되지않",
  "권장되지", "권장하지",
  "do not use", "don't use", "does not use",
  "disable", "disabled", "deprecated",
  "reject", "rejected", "forbid", "forbidden",
  "remove", "removed", "never use",
  "not supported", "unsupported",
  "not recommended"
];

/** uncertain polarity 마커 — 추정·가능성·불확실 류. 최우선. */
const UNCERTAIN_MARKERS = [
  "아마", "아마도",
  "추정", "추정된다",
  "가능성",
  "불확실",
  "일 수도 있",
  "로 보임", "로 보인다",
  "일 것으로 보",
  "maybe", "possibly", "likely",
  "perhaps", "might", "could be",
  "seems", "appears to"
];

/** 공백·특수문자 제거 (마커 유연 매칭용) */
const compact = (s) => s.replace(/[\s·,.!?'"`~@#$%^&*()_+=|\\\-/<>{}[\]]/g, "");

/**
 * @typedef {Object} Claim
 * @property {string} subject
 * @property {string} predicate
 * @property {string|null} object
 * @property {"positive"|"negative"|"uncertain"} polarity
 * @property {number} confidence
 * @property {"morpheme-rule"|"llm"|"manual"} extractor
 * @property {string} ruleVersion
 */

export class ClaimExtractor {

  /**
   * @param {{ morphemeIndex?: MorphemeIndex, ruleVersion?: string }} [opts]
   */
  constructor({ morphemeIndex = new MorphemeIndex(), ruleVersion = "v1" } = {}) {
    this.morphemeIndex = morphemeIndex;
    this.ruleVersion   = ruleVersion;
  }

  /**
   * content 에서 claim 트리플 목록을 추출. 현재 구현은 content 당 1개 claim 만 생성.
   * 다중 claim 추출은 Phase 1 LLM fallback 에서 처리.
   *
   * @param {string} content
   * @param {string} [topic]
   * @returns {Promise<Claim[]>}
   */
  async extract(content, topic) {
    if (typeof content !== "string" || content.trim().length === 0) return [];

    const tokens = await this._safeTokenize(content);

    const polarityResult = this._detectPolarity(content);

    const subject   = this._deriveSubject(topic, tokens);
    const predicate = this._derivePredicate(polarityResult.matchedMarker, tokens);
    const object    = this._deriveObject(tokens, subject);

    return [{
      subject,
      predicate,
      object,
      polarity   : polarityResult.polarity,
      confidence : polarityResult.confidence,
      extractor  : "morpheme-rule",
      ruleVersion: this.ruleVersion
    }];
  }

  /**
   * MorphemeIndex.tokenize 호출. 실패 시 빈 배열. 테스트/LLM 비활성 환경 내성.
   */
  async _safeTokenize(content) {
    try {
      const out = await this.morphemeIndex.tokenize(content);
      return Array.isArray(out) ? out.filter(t => typeof t === "string" && t.length > 0) : [];
    } catch {
      return [];
    }
  }

  /**
   * polarity 판정. 우선순위: uncertain > negative > positive > default(uncertain).
   *
   * @param {string} content
   * @returns {{ polarity: Claim["polarity"], confidence: number, matchedMarker: string|null }}
   */
  _detectPolarity(content) {
    const lower        = content.toLowerCase();
    const compactLower = compact(lower);

    const hit = (markers) => {
      for (const m of markers) {
        const lm = m.toLowerCase();
        if (lower.includes(lm) || compactLower.includes(compact(lm))) return m;
      }
      return null;
    };

    const uncertainHit = hit(UNCERTAIN_MARKERS);
    if (uncertainHit) {
      return { polarity: "uncertain", confidence: 0.5, matchedMarker: uncertainHit };
    }

    const negativeHit = hit(NEGATIVE_MARKERS);
    if (negativeHit) {
      return { polarity: "negative", confidence: 0.75, matchedMarker: negativeHit };
    }

    const positiveHit = hit(POSITIVE_MARKERS);
    if (positiveHit) {
      return { polarity: "positive", confidence: 0.7, matchedMarker: positiveHit };
    }

    return { polarity: "uncertain", confidence: 0.4, matchedMarker: null };
  }

  _deriveSubject(topic, tokens) {
    if (topic && typeof topic === "string" && topic.trim().length > 0) return topic.trim();
    if (tokens.length > 0) return tokens[0];
    return "unknown";
  }

  _derivePredicate(matchedMarker, tokens) {
    if (matchedMarker) return matchedMarker;
    for (const t of tokens) {
      if (POSITIVE_MARKERS.includes(t) || NEGATIVE_MARKERS.includes(t)) return t;
    }
    return "mentions";
  }

  _deriveObject(tokens, subject) {
    if (tokens.length <= 1) return null;
    for (let i = tokens.length - 1; i >= 0; i--) {
      if (tokens[i] !== subject) return tokens[i];
    }
    return null;
  }
}
