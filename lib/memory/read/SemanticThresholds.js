/**
 * SemanticThresholds - 임베딩 모델별 시맨틱 하한
 *
 * 작성자: 최진호
 * 작성일: 2026-11-02
 *
 * 모델마다 코사인 값이 몰리는 대역이 달라 하한 하나를 모든 모델에 쓸 수 없다. semanticSearch.modelCalibration에서
 * EMBEDDING_MODEL에 맞는 항목을 고르고, 없으면 semanticSearch.minSimilarity, 학습 하한 0.10, 의도별 보정 적용이다.
 * L3 검색(FragmentSearch)과 학습 하한(SearchParamAdaptor)이 같은 값을 쓴다.
 *
 * rankingSimilarity는 순위 점수(검색 단계 _computeRankScore, 최종 정렬 computeRecallScore)에 넣을 유사도다.
 * 항목에 rankBand [lo, hi]가 있으면 lo~hi 구간의 코사인을 0~1로 펴고(lo 이하는 0, hi 이상은 1), 없으면 값을 그대로
 * 돌려준다. lo 이하는 무관 파편 대역이라 순위에 기여하지 않는다. similarity 없이 들어온 후보도 순위용 코사인
 * (RankSimilarity)을 받아 같은 기준으로 펴진다.
 * 파편의 similarity 값(응답, threshold 필터, MMR, 중복 판정)은 바꾸지 않는다.
 */

import { MEMORY_CONFIG }   from "../../../config/memory.js";
import { EMBEDDING_MODEL } from "../../config.js";

/** 보정이 없는 모델의 학습 하한 */
export const DEFAULT_FLOOR = 0.10;

/**
 * @param {string} [model]
 * @returns {{minSimilarity: number, floor: number, profileDelta: boolean, rankBand: [number, number]|null, modelRanking: boolean}}
 */
export function semanticThresholds(model = EMBEDDING_MODEL) {
  const cfg   = MEMORY_CONFIG.semanticSearch ?? {};
  const entry = findEntry(cfg, model);
  if (entry) {
    return {
      minSimilarity: entry.minSimilarity, floor: entry.floor ?? DEFAULT_FLOOR, profileDelta: entry.profileDelta !== false,
      rankBand: validBand(entry.rankBand), modelRanking: Boolean(entry.ranking)
    };
  }
  return { minSimilarity: cfg.minSimilarity ?? 0.35, floor: DEFAULT_FLOOR, profileDelta: true, rankBand: null, modelRanking: false };
}

/** semanticSearch.modelCalibration에서 model 이름을 포함하는 첫 항목 */
function findEntry(semanticSearch, model) {
  const name = String(model ?? "").toLowerCase();
  return (semanticSearch?.modelCalibration ?? []).find(c => c.match && name.includes(String(c.match).toLowerCase()));
}

/** [lo, hi]이고 0 <= lo < hi <= 1이면 그대로, 아니면 null */
function validBand(band) {
  if (!Array.isArray(band) || band.length !== 2) return null;
  const [lo, hi] = band.map(Number);
  return Number.isFinite(lo) && Number.isFinite(hi) && lo >= 0 && hi <= 1 && lo < hi ? [lo, hi] : null;
}

/**
 * 순위 점수에 넣을 유사도. rankBand가 없으면 similarity 그대로다.
 *
 * @param {number} similarity 코사인 유사도
 * @param {[number, number]|null} [band] semanticThresholds().rankBand
 * @returns {number}
 */
export function rankingSimilarity(similarity, band = semanticThresholds().rankBand) {
  if (!band || !Number.isFinite(similarity)) return similarity;
  const [lo, hi] = band;
  return Math.min(1, Math.max(0, (similarity - lo) / (hi - lo)));
}

/** 모델 항목의 ranking이 바꿀 수 있는 키 */
const RANKING_KEYS = Object.freeze(["importanceWeight", "recencyWeight", "semanticWeight", "recencyHalfLifeDays"]);

/**
 * 현재 모델 항목의 ranking 덮어쓰기를 반영한 설정 사본. 덮어쓸 것이 없으면 원본을 그대로 돌려준다.
 * 순위 가중치를 읽는 두 곳(FragmentSearch._deduplicate, buildRecallScorer)이 질의 프로파일을 적용한 뒤에 부른다.
 * exactKeywordBoost(검색 단계 키워드 정확 일치 가산)와 lexicalWeightFallback(최종 정렬 키워드 일치 가산, 재정렬 점수 없는
 * 파편)은 semanticWeight와의 크기 관계로 정한 값이라(프로파일별 값 포함) semanticWeight가 바뀐 비율만큼 함께 바꾼다.
 * lexicalWeightReranked는 재정렬 점수에 더하는 값이라 semanticWeight와 무관해 그대로 둔다.
 *
 * @param {Object} config MEMORY_CONFIG 또는 프로파일을 적용한 사본
 * @param {string} [model]
 * @returns {Object}
 */
export function withModelRanking(config, model = EMBEDDING_MODEL) {
  const entry = findEntry(config.semanticSearch, model);
  if (!entry?.ranking) return config;
  const overrides = Object.fromEntries(RANKING_KEYS.filter(k => Number.isFinite(entry.ranking[k])).map(k => [k, entry.ranking[k]]));
  if (Object.keys(overrides).length === 0) return config;
  const base  = config.ranking;
  const ratio = Number.isFinite(overrides.semanticWeight) && base.semanticWeight > 0 ? overrides.semanticWeight / base.semanticWeight : 1;
  const exactKeywordBoost     = (base.exactKeywordBoost ?? 0.35) * ratio;
  const lexicalWeightFallback = (base.lexicalWeightFallback ?? 0.18) * ratio;
  return { ...config, ranking: { ...base, ...overrides, exactKeywordBoost, lexicalWeightFallback } };
}
