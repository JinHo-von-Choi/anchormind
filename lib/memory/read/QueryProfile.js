/**
 * QueryProfile - 질의 의도별 검색 프로파일 해석
 *
 * 작성자: 최진호
 * 작성일: 2026-08-28
 *
 * 현행 검색은 점수 선형결합이 아니라 RRF 순위 융합이므로 lexical 대 vector 비중을
 * 단일 스칼라로 조절할 손잡이가 없다. 대신 이미 존재하는 손잡이 네 종
 * (RRF 레이어 weightFactor, 시맨틱 임계값, 형태소 프로브 채택 조건, 랭킹 lexical 가중치)을
 * 의도별 프로파일로 묶어 한 번에 전환한다.
 *
 * ranking의 importanceWeight/recencyWeight/semanticWeight는 합계 1.0을 기동 게이트가
 * 강제하므로(config/validate-memory-config.js) 프로파일 조정 대상에서 제외한다.
 */

import { MEMORY_CONFIG }        from "../../../config/memory.js";
import { classifyQueryIntent }  from "../signals/SearchEventRecorder.js";

/** 시맨틱 임계값 클램프 범위. SearchParamAdaptor와 동일 범위를 쓴다. */
const SIM_CLAMP_MIN = 0.10;
const SIM_CLAMP_MAX = 0.60;

/** 프로파일 미적용 시 사용하는 항등 프로파일 */
const NEUTRAL_PROFILE = Object.freeze({
  intent                   : "HYBRID",
  applied                  : false,
  l2WeightFactor           : 1.0,
  l3WeightFactor           : 1.0,
  minSimilarityDelta       : 0,
  morphemeFallbackThreshold: null,
  exactKeywordBoost        : null,
  lexicalWeightReranked    : null,
  lexicalWeightFallback    : null,
});

/**
 * 질의 프로파일 기능이 켜져 있는지 판정한다.
 * 환경변수가 명시적으로 "false"이면 항상 꺼진다.
 *
 * @returns {boolean}
 */
export function isProfileEnabled() {
  if (process.env.MEMENTO_QUERY_PROFILE_ENABLED === "false") return false;
  if (process.env.MEMENTO_QUERY_PROFILE_ENABLED === "true")  return true;
  return MEMORY_CONFIG.queryProfiles?.enabled !== false;
}

/**
 * 질의 객체에서 적용할 프로파일을 해석한다.
 *
 * @param {{text?: string, keywords?: string[], topic?: string}} query
 * @returns {Object} 프로파일. applied=false이면 현행 동작과 동일하다
 */
export function resolveQueryProfile(query) {
  if (!isProfileEnabled()) return NEUTRAL_PROFILE;

  const intent   = classifyQueryIntent(query);
  const profiles = MEMORY_CONFIG.queryProfiles || {};
  const spec     = profiles[intent];

  if (!spec) return { ...NEUTRAL_PROFILE, intent };

  return {
    intent,
    applied                  : true,
    l2WeightFactor           : spec.l2WeightFactor            ?? 1.0,
    l3WeightFactor           : spec.l3WeightFactor            ?? 1.0,
    minSimilarityDelta       : spec.minSimilarityDelta        ?? 0,
    morphemeFallbackThreshold: spec.morphemeFallbackThreshold ?? null,
    exactKeywordBoost        : spec.exactKeywordBoost         ?? null,
    lexicalWeightReranked    : spec.lexicalWeightReranked     ?? null,
    lexicalWeightFallback    : spec.lexicalWeightFallback     ?? null,
  };
}

/**
 * 시맨틱 임계값에 프로파일 보정을 적용하고 허용 범위로 클램프한다.
 *
 * @param {number} baseSimilarity
 * @param {Object} profile
 * @returns {number}
 */
export function applySimilarityDelta(baseSimilarity, profile) {
  const delta = profile?.minSimilarityDelta ?? 0;
  if (!Number.isFinite(baseSimilarity)) return baseSimilarity;
  const adjusted = baseSimilarity + delta;
  return Math.min(SIM_CLAMP_MAX, Math.max(SIM_CLAMP_MIN, adjusted));
}

/**
 * 프로파일의 랭킹 보정을 반영한 설정 사본을 만든다.
 * 원본 MEMORY_CONFIG는 변경하지 않으며, 합계 1.0 제약이 걸린 세 가중치는 건드리지 않는다.
 *
 * @param {Object} config  기준 설정 (보통 MEMORY_CONFIG)
 * @param {Object} profile resolveQueryProfile 결과
 * @returns {Object} 보정된 설정. 보정할 것이 없으면 원본을 그대로 반환한다
 */
export function applyProfileToConfig(config, profile) {
  if (!profile?.applied) return config;

  const overrides = {};
  if (profile.exactKeywordBoost     !== null) overrides.exactKeywordBoost     = profile.exactKeywordBoost;
  if (profile.lexicalWeightReranked !== null) overrides.lexicalWeightReranked = profile.lexicalWeightReranked;
  if (profile.lexicalWeightFallback !== null) overrides.lexicalWeightFallback = profile.lexicalWeightFallback;

  if (Object.keys(overrides).length === 0) return config;

  return {
    ...config,
    ranking: { ...config.ranking, ...overrides },
  };
}

/**
 * 형태소 보조 프로브의 채택 임계값을 해석한다.
 *
 * @param {number} baseThreshold
 * @param {Object} profile
 * @returns {number}
 */
export function resolveMorphemeThreshold(baseThreshold, profile) {
  const override = profile?.morphemeFallbackThreshold;
  return Number.isFinite(override) ? override : baseThreshold;
}
