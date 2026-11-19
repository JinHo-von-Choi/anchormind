/**
 * ContextCoreSelection - context core 후보 선택
 *
 * 작성자: 최진호
 * 작성일: 2026-11-19
 *
 * 유형별 core 후보에서 유형마다 하나를 보장하고(seedGuaranteed), 나머지를 온도 정렬(byTemperature)로 세운 뒤
 * 파편 수 상한, 유형별 슬롯, 문자 예산 안에서 채운다(fillWithinBudget). 적용 실패가 쌓인 교훈은 후보에서 뺀다
 * (dropContestedLessons). 온도 정렬의 가산점 근거를 바꿨을 때의 선택 차이는 표본 요청에서만 계산해
 * 지표로 남긴다(shadowTemperature). ContextBuilder가 이 모듈을 쓰고 같은 이름으로 다시 내보낸다.
 */

import { MEMORY_CONFIG }               from "../../../config/memory.js";
import { CONTEXT_SHADOW_RATE }         from "../../config.js";
import { computeWorkspaceDecayFactor } from "./FragmentSearch.js";
import { byDescendingScore }           from "./DeterministicRanking.js";
import { loadUseStats }                from "../signals/UseEvents.js";
import { loadLessonOutcomeStats, dropContested } from "../signals/LessonOutcomes.js";
import { recordShadowDiff, selectionDiff, contestedExcludedTotal } from "./experience-metrics.js";

/**
 * 유형마다 최상위 파편 하나씩을 자리 보장으로 담는다.
 *
 * 예산이 빠듯해도 각 유형이 최소 하나는 주입돼야 맥락이 한쪽으로 쏠리지 않는다.
 *
 * @returns {{guaranteed: Map, seen: Set, usedChars: number}}
 */
export function seedGuaranteed(types, typeFragMap) {
  const guaranteed = new Map();
  const seen       = new Set();
  let   usedChars  = 0;

  for (const type of types) {
    const frags = typeFragMap.get(type) || [];
    const top = frags.find(fragment => !seen.has(fragment?.id ?? fragment));
    if (!top) continue;
    guaranteed.set(type, [top]);
    seen.add(top.id ?? top);
    usedChars += (top.content || "").length;
  }
  return { guaranteed, seen, usedChars };
}

/**
 * 자리 보장에 들지 못한 나머지 후보를 모은다. 이미 담긴 파편은 뺀다.
 *
 * @returns {Array<Object>}
 */
export function collectExtras(types, typeFragMap, seen) {
  const extras = [];
  for (const type of types) {
    const frags = typeFragMap.get(type) || [];
    for (let i = 1; i < frags.length; i++) {
      const identity = frags[i]?.id ?? frags[i];
      if (seen.has(identity)) continue;
      extras.push(frags[i]);
      seen.add(identity);
    }
  }
  return extras;
}

/**
 * 온도 점수 비교기를 만든다.
 *
 * 최근 가산점(warmBoost)과 빈도 가산점(highAccessBoost)의 근거는 signal이 정한다.
 *   exposure  노출 기록(accessed_at, access_count). 지금까지의 방식이다
 *   use       사용 사건(lib/memory/signals/UseEvents.js)의 마지막 시각과 수. useStats에 없는 파편은 가산점이 없다
 *   none      두 가산점을 주지 않는다
 * 학습 추출로 들어온 파편의 가산점과 워크스페이스 감쇠는 signal과 무관하다.
 *
 * @param {string|null} workspace
 * @param {{signal?: "exposure"|"use"|"none", useStats?: Map<string, {count: number, last: Date}>|null}} [options]
 * @returns {(a: Object, b: Object) => number}
 */
export function byTemperature(workspace, { signal = "exposure", useStats = null } = {}) {
  const boost        = MEMORY_CONFIG.contextInjection?.temperatureBoost || {};
  const warmMs       = (boost.warmWindowDays || 7) * 86400000;
  const accessThresh = boost.highAccessThreshold || 5;
  const useThresh    = boost.highUseThreshold || 2;
  const now          = Date.now();

  const recency = (frag) => {
    if (signal === "none") return { recentAt: 0, frequent: false };
    if (signal === "use") {
      const stat = useStats?.get(frag.id);
      return { recentAt: stat ? stat.last.getTime() : 0, frequent: (stat?.count ?? 0) >= useThresh };
    }
    return {
      recentAt: frag.accessed_at ? new Date(frag.accessed_at).getTime() : 0,
      frequent: (frag.access_count || 0) >= accessThresh
    };
  };

  const score = (frag) => {
    let s = frag.importance || 0;
    const { recentAt, frequent } = recency(frag);
    if (recentAt > 0 && now - recentAt < warmMs)      s += boost.warmBoost || 0;
    if (frequent)                                     s += boost.highAccessBoost || 0;
    if (frag.source === "learning_extraction")        s += boost.learningBoost || 0;
    return s * computeWorkspaceDecayFactor(frag, workspace);
  };

  return byDescendingScore(score);
}

/** core 후보 문자 예산(토큰 1500 × 4) */
export const CORE_BUDGET_TOKENS = 1500;

/**
 * 유형별 core 후보에서 주어진 온도 정렬로 고른 파편 id. #loadCoreMemory와 같은 절차를 사본에서 밟는다.
 *
 * @param {string[]} types
 * @param {Map<string, object[]>} typeFragMap
 * @param {(a: Object, b: Object) => number} comparator
 * @returns {string[]}
 */
export function coreSelectionIds(types, typeFragMap, comparator) {
  const { guaranteed, seen, usedChars } = seedGuaranteed(types, typeFragMap);
  const extras = collectExtras(types, typeFragMap, seen).sort(comparator);
  fillWithinBudget(guaranteed, extras, { usedChars, coreCharBudget: CORE_BUDGET_TOKENS * 4 });
  return [...guaranteed.values()].flat().map(f => f?.id).filter(Boolean);
}

/**
 * 온도 정렬 방식별 선택 차이를 지표에 남긴다. 기준은 노출 방식이다. 응답 뒤에서 표본 요청만 부른다.
 *
 * @param {string[]} types
 * @param {Map<string, object[]>} typeFragMap
 * @param {string|null} workspace
 * @param {Map<string, {count: number, last: Date}>|null} [useStats] - 이미 불러온 사용 사건 집계
 * @returns {Promise<void>}
 */
export async function shadowTemperature(types, typeFragMap, workspace, useStats = null) {
  const ids   = [...typeFragMap.values()].flat().map(f => f?.id).filter(Boolean);
  const stats = useStats ?? await loadUseStats(ids);
  const base  = coreSelectionIds(types, typeFragMap, byTemperature(workspace));
  recordShadowDiff("use_signal", selectionDiff(base, coreSelectionIds(types, typeFragMap, byTemperature(workspace, { signal: "use", useStats: stats }))));
  recordShadowDiff("no_boost",   selectionDiff(base, coreSelectionIds(types, typeFragMap, byTemperature(workspace, { signal: "none" }))));
}

/**
 * 파편 수 상한과 유형별 슬롯, 문자 예산 안에서 나머지를 채운다.
 *
 * 예산 경계에 걸린 파편은 남은 자리가 쓸 만큼 크면 잘라서라도 넣는다. 잘라
 * 넣은 뒤에는 더 담지 않는다.
 *
 * @returns {number} 최종 사용 문자 수
 */
export function fillWithinBudget(guaranteed, extras, { usedChars, coreCharBudget }) {
  const maxCore   = MEMORY_CONFIG.contextInjection?.maxCoreFragments || 15;
  const typeSlots = MEMORY_CONFIG.contextInjection?.typeSlots || {};

  const typeCounters = {};
  let   totalAdded   = 0;
  for (const [type, frags] of guaranteed) {
    typeCounters[type] = frags.length;
    totalAdded        += frags.length;
  }

  const put = (typeKey, frag) => {
    const arr = guaranteed.get(typeKey) || [];
    arr.push(frag);
    guaranteed.set(typeKey, arr);
    typeCounters[typeKey] = (typeCounters[typeKey] || 0) + 1;
    totalAdded++;
  };

  for (const f of extras) {
    if (totalAdded >= maxCore) break;

    const typeKey = f.type || "general";
    if ((typeCounters[typeKey] || 0) >= (typeSlots[typeKey] || 5)) continue;

    const cost = (f.content || "").length;
    if (usedChars + cost > coreCharBudget) {
      const remaining = coreCharBudget - usedChars;
      if (remaining > 80) {
        put(typeKey, { ...f, content: f.content.substring(0, remaining - 3) + "..." });
        usedChars += remaining;
      }
      break;
    }

    put(typeKey, f);
    usedChars += cost;
  }

  return usedChars;
}

/**
 * 비교 계산을 할 요청인지. MEMENTO_CONTEXT_SHADOW_RATE 비율로 고른다.
 *
 * @param {number} [rate]
 * @param {() => number} [random]
 * @returns {boolean}
 */
export function shadowSampled(rate = CONTEXT_SHADOW_RATE, random = Math.random) {
  return rate > 0 && random() < rate;
}

/**
 * 유형별 core 후보에서 적용 실패가 쌓인 교훈(contested)을 뺀 새 맵. procedure 후보만 조회한다. 조회가 실패하면
 * 그대로 둔다(lib/memory/signals/LessonOutcomes.js).
 *
 * @param {Map<string, object[]>} typeFragMap
 * @returns {Promise<Map<string, object[]>>}
 */
export async function dropContestedLessons(typeFragMap) {
  const ids = [...typeFragMap.values()].flat().filter(f => f?.type === "procedure").map(f => f.id).filter(Boolean);
  if (ids.length === 0) return typeFragMap;
  const stats = await loadLessonOutcomeStats(ids);
  if (stats.size === 0) return typeFragMap;
  const result = new Map();
  let excluded = 0;
  for (const [type, fragments] of typeFragMap) {
    const kept = dropContested(fragments, stats);
    excluded += (fragments?.length ?? 0) - kept.length;
    result.set(type, kept);
  }
  if (excluded > 0) contestedExcludedTotal.inc(excluded);
  return result;
}
