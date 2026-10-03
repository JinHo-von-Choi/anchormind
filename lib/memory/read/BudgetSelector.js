/**
 * BudgetSelector - recall 토큰 예산 선택
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 두 가지 절단 규칙을 순수 함수로 둔다.
 *
 * 1. trimInSearchOrder: 검색 순서(RRF 또는 리랭커 순서)대로 예산을 채우는 절단.
 *    정확 일치(_kwExact)와 keywords 보조(_kwSupplement) 태그가 있으면 슬롯 몫을 먼저 확보한다.
 *    MEMENTO_RANK_BEFORE_BUDGET=off 경로와 recall 밖의 검색 호출이 쓰며, 예산 선택의 기준해이기도 하다.
 *
 * 2. selectWithinBudget: 최종 점수(computeRecallScore)를 매긴 뒤의 예산 선택.
 *    후보 전체의 토큰 합이 예산 이하이면 전부 고른다. 넘으면 아래 두 해를 만들고 최종 점수 합이 큰
 *    쪽을 고른다(같으면 탐욕해). 점수 합은 id 순서로 더하므로 입력 순서와 무관하다.
 *      탐욕해: 빈 집합에서 시작한다.
 *      기준해: 검색 순서 절단(trimInSearchOrder)이 고른 집합에서 시작한다.
 *    두 해 모두 같은 두 단계를 거친다.
 *      구획 단계: 구획(exact, supplement, linked, search) 순서로, 아직 고른 항목이 없는 구획마다
 *        남은 예산에 들어가고 최종 점수가 0보다 큰 항목 가운데 점수가 가장 높은 것 하나를 고른다.
 *      채움 단계: 남은 예산에 들어가는 항목 가운데 MMR 이득을 토큰 수(최소 1)로 나눈 값이 가장 큰
 *        항목을 하나씩 고른다. 이득은 lambda * 점수 - (1 - lambda) * (이미 고른 항목과의 최대 유사도)다.
 *    동점은 최종 점수 내림차순, id 오름차순으로 정한다.
 *    최종 점수는 0 이상이므로(rerankerScore는 sigmoid 값, 복합 점수와 lexical 가산은 0 이상, workspace
 *    감쇠는 양수 배율) 기준해의 점수 합은 검색 순서 절단의 점수 합 이상이고, 고른 해도 그 이상이다.
 *
 * MMR 유사도는 두 파편 모두 임베딩 유사도(similarity)를 가진 경우에만 keywords 겹침 비율로 계산하고,
 * 어느 한쪽이라도 similarity나 keywords가 없으면 0(서로 다른 것)으로 본다.
 *
 * 3. selectForRecall: recall이 쓰는 순서. 정확한 합이 예산 이하이면 전부(exceedsBudget, 예산을 넘는 순간까지만
 *    센다). 넘으면 추정값(estimateTokens: 이 요청에서 센 수, 저장된 토큰 수, 본문 길이 / 4. 요청 밖의 토큰 기억은 쓰지 않는다)으로 selectWithinBudget을 하고
 *    (후보가 poolLimit를 넘으면 기준 집합을 그대로 쓴다), 고른 파편만 정확히 세어 verifyExactBudget으로 예산을 맞춘다.
 *    점수 합 비교의 기준 집합은 같은 추정값으로 계산한 검색 순서 절단이며, 그 파편만 정확히 세어 확인한 뒤 고른 해보다
 *    정확한 점수 합이 크면 확인된 기준 집합을 쓴다. 태그 없는 검색은 절단 경계까지 정확히 세므로 off 경로의 절단과 같다.
 *
 * 비용: 해를 만드는 후보 n은 poolLimit(recall은 200 + 연결 파편 상한) 이하이고, selectWithinBudget 자체도
 * SELECTION_POOL_MAX(600)를 넘으면 해를 만들지 않는다. 토큰 수는 파편 객체마다 한 번, 같은 본문은 요청을 넘어
 * 최근 CONTENT_TOKEN_CACHE_LIMIT개까지 한 번만 센다.
 * 채움 단계는 고를 때마다 남은 후보를 한 번 훑고 최대 유사도를 갱신하므로 해 하나에 O(n * m)이다
 * (m은 고른 수, m <= n). 두 해를 만들므로 keywords 겹침 계산은 최대 2 * n^2회다.
 */

import { MEMORY_CONFIG } from "../../../config/memory.js";
import { countTokens }   from "../write/FragmentFactory.js";

/** recall 예산 선택에 넣는 검색 후보의 상한 */
export const RANK_CANDIDATE_LIMIT = 200;

/** MMR 관련성 가중치 */
export const MMR_LAMBDA = 0.7;

/** 구획 단계의 순서 */
export const SECTION_ORDER = Object.freeze(["exact", "supplement", "linked", "search"]);

/** selectWithinBudget이 해를 만드는 후보 수의 상한. 넘으면 기준 집합(검색 순서 절단)을 그대로 쓴다. */
export const SELECTION_POOL_MAX = 600;

/**
 * 정확한 토큰 수의 기억. 값은 countTokens(본문)이며 본문만의 함수이므로, 기억이 있든 없든 fragmentTokens의
 * 결과는 같다. 객체별 기억은 센 본문 문자열을 함께 두고 같을 때만 쓰며, 본문별 기억은 본문 문자열 자체를
 * 키로 쓴다(해시가 아니므로 충돌이 없다). 추정값(estimateTokens)은 이 기억을 읽지 않는다.
 */
let countedTokens = new WeakMap();

/** 본문 문자열별 토큰 수의 상한 크기. 넘으면 가장 오래 쓰지 않은 항목을 버린다. */
export const CONTENT_TOKEN_CACHE_LIMIT = 4096;
const contentTokens = new Map();

/** 정확한 토큰 수의 기억을 비운다(시험에서 새 프로세스와 같은 상태를 만들 때 쓴다). */
export function clearTokenCaches() {
  countedTokens = new WeakMap();
  contentTokens.clear();
}

/**
 * 본문의 토큰 수(countTokens와 같은 값). 같은 본문은 요청을 넘어 최근 CONTENT_TOKEN_CACHE_LIMIT개까지 기억한다.
 *
 * @param {string} content
 * @returns {number}
 */
function countContentTokens(content) {
  const hit = contentTokens.get(content);
  if (hit !== undefined) {
    contentTokens.delete(content);
    contentTokens.set(content, hit);
    return hit;
  }
  const tokens = countTokens(content);
  contentTokens.set(content, tokens);
  if (contentTokens.size > CONTENT_TOKEN_CACHE_LIMIT) contentTokens.delete(contentTokens.keys().next().value);
  return tokens;
}

/**
 * 파편의 정확한 토큰 수. estimated_tokens가 있으면 그 값을, 없으면 countTokens(본문)이다.
 *
 * @param {Object} fragment
 * @returns {number}
 */
export function fragmentTokens(fragment) {
  if (fragment.estimated_tokens) return fragment.estimated_tokens;
  const content = fragment.content || "";
  const cached  = countedTokens.get(fragment);
  if (cached !== undefined && cached.content === content) return cached.tokens;
  const tokens = countContentTokens(content);
  countedTokens.set(fragment, { content, tokens });
  return tokens;
}

/**
 * 예산 선택용 토큰 추정값. 요청의 입력만으로 정해진다: estimated_tokens 속성, 이 요청에서 정확히 센 수
 * (exactCounts), 저장된 토큰 수(_storedTokens, 양의 정수), 본문 길이 / 4(올림) 순이다. 프로세스 전체의 토큰
 * 기억은 읽지 않으므로 앞선 요청이 결과를 바꾸지 않는다. 응답의 totalTokens와 예산 확인에는 쓰지 않는다.
 *
 * @param {Object} fragment
 * @param {Map<Object, number>} [exactCounts] 이 요청에서 exceedsBudget이 센 정확한 수
 * @returns {number}
 */
export function estimateTokens(fragment, exactCounts = null) {
  if (fragment.estimated_tokens) return fragment.estimated_tokens;
  const counted = exactCounts?.get(fragment);
  if (counted !== undefined) return counted;
  if (Number.isInteger(fragment._storedTokens) && fragment._storedTokens > 0) return fragment._storedTokens;
  return Math.ceil((fragment.content || "").length / 4);
}

/**
 * 정확한 토큰 수의 상한(세지 않음). 토큰 하나는 UTF-8 1바이트 이상이므로 바이트 수 이하다.
 *
 * @param {Object} fragment
 * @returns {number}
 */
function tokenUpperBound(fragment) {
  return fragment.estimated_tokens || Buffer.byteLength(fragment.content || "", "utf8");
}

/**
 * 정확한 토큰 합이 예산을 넘는지. 상한 합이 예산 이하이면 세지 않고 false다. 아니면 주어진 순서대로
 * 정확히 세다가 합이 예산을 넘는 순간 true를 돌려주므로, 예산이 묶이면 대략 예산만큼의 파편만 센다.
 * 센 수는 exactCounts에 남긴다. 어느 파편을 세는지는 입력만으로 정해진다.
 *
 * @param {Object[]} fragments
 * @param {number}   budget
 * @param {Map<Object, number>} [exactCounts]
 * @returns {boolean}
 */
export function exceedsBudget(fragments, budget, exactCounts = null) {
  let upper = 0;
  for (const f of fragments) upper += tokenUpperBound(f);
  if (upper <= budget) return false;
  let exact = 0;
  for (const f of fragments) {
    const tokens = fragmentTokens(f);
    exactCounts?.set(f, tokens);
    exact += tokens;
    if (exact > budget) return true;
  }
  return false;
}

/**
 * 주어진 순서대로 정확히 세어 exactCounts에 남기고, 합이 예산을 넘는 파편까지 센 뒤 멈춘다.
 *
 * @param {Object[]} fragments
 * @param {number}   budget
 * @param {Map<Object, number>} exactCounts
 */
function countPrefixExactly(fragments, budget, exactCounts) {
  let exact = 0;
  for (const f of fragments) {
    const tokens = exactCounts.get(f) ?? fragmentTokens(f);
    exactCounts.set(f, tokens);
    exact += tokens;
    if (exact > budget) return;
  }
}

/**
 * 고른 파편을 정확한 토큰 수로 확인하고, 합이 예산을 넘으면 넘지 않을 때까지 이득이 가장 작은 파편부터 뺀다.
 * protectedItems가 있으면 그 밖의 파편을 모두 뺀 뒤에야 그 안의 파편을 뺀다. 같은 무리 안의 순서는 최종 점수 /
 * max(정확한 토큰 수, 1) 오름차순, 같으면 점수 오름차순, 같으면 id 내림차순(id가 큰 쪽을 먼저 뺀다)이다.
 *
 * @param {Object[]} selected
 * @param {{budget: number, scoreOf: (fragment: Object) => number, protectedItems?: Set<Object>}} opts
 * @returns {{kept: Object[], dropped: Object[], tokens: number}}
 */
export function verifyExactBudget(selected, { budget, scoreOf, protectedItems = null }) {
  const entries = selected.map(fragment => {
    const raw    = Number(scoreOf(fragment));
    const score  = Number.isFinite(raw) ? raw : 0;
    const tokens = fragmentTokens(fragment);
    const rank   = protectedItems?.has(fragment) ? 1 : 0;
    return { fragment, key: String(fragment.id), score, tokens, rank, density: score / Math.max(tokens, 1) };
  });
  let tokens = entries.reduce((sum, e) => sum + e.tokens, 0);
  if (tokens <= budget) return { kept: selected, dropped: [], tokens };

  const dropOrder = [...entries].sort((a, b) =>
    (a.rank - b.rank) || (a.density - b.density) || (a.score - b.score) || (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
  const dropped   = new Set();
  for (const e of dropOrder) {
    if (tokens <= budget) break;
    dropped.add(e.fragment);
    tokens -= e.tokens;
  }
  return {
    kept   : selected.filter(f => !dropped.has(f)),
    dropped: selected.filter(f => dropped.has(f)),
    tokens
  };
}

/**
 * 최종 점수 합(id 순서로 더한다).
 *
 * @param {Object[]} fragments
 * @param {(fragment: Object) => number} scoreOf
 * @returns {number}
 */
function exactScoreSum(fragments, scoreOf) {
  return scoreSumById(fragments.map(f => {
    const raw = Number(scoreOf(f));
    return { key: String(f.id), score: Number.isFinite(raw) ? raw : 0 };
  }));
}

/**
 * recall의 예산 선택.
 *   1. 정확한 토큰 합이 예산 이하이면 전부 고른다(exceedsBudget).
 *   2. 기준 집합(baselineIds, 같은 추정값으로 계산한 검색 순서 절단)의 파편만 정확히 세어(exactCounts에 남긴다)
 *      verifyExactBudget으로 예산에 맞춘 것을 확인된 기준 집합으로 둔다. 태그 없는 검색은 기준 집합이 정확히 센
 *      앞부분이므로 확인된 기준 집합은 off 경로의 절단과 같다.
 *   3. 추정값(estimateTokens)으로 확인된 기준 집합을 시작점 가운데 하나로 해를 고르고(후보 수가 poolLimit를 넘으면
 *      확인된 기준 집합을 그대로 쓴다), 고른 파편을 정확히 세어 예산을 넘으면 확인된 기준 집합 밖의 파편부터 뺀다.
 *   4. 정확한 최종 점수 합이 확인된 기준 집합보다 작으면 확인된 기준 집합을 고른다(같으면 고른 해).
 *
 * @param {Object[]} pool 검색 후보와 연결 파편(id 중복 없음), 검색 순서
 * @param {Object}   opts
 * @param {number}   opts.budget
 * @param {(fragment: Object) => number} opts.scoreOf
 * @param {Set<*>}   [opts.baselineIds] 같은 추정값으로 계산한 검색 순서 절단의 id
 * @param {number}   [opts.poolLimit]   이보다 후보가 많으면 확인된 기준 집합을 그대로 쓴다
 * @param {Map<Object, number>} [opts.exactCounts] 이 요청에서 센 정확한 수(partitionCandidates와 같은 Map)
 * @returns {{selectedIds: Set<*>, strategy: string, tokens: number|null, dropped: number}}
 */
export function selectForRecall(pool, { budget, scoreOf, baselineIds = new Set(), poolLimit = SELECTION_POOL_MAX, exactCounts = new Map() }) {
  if (!exceedsBudget(pool, budget, exactCounts)) {
    return { selectedIds: new Set(pool.map(f => f.id)), strategy: "all", tokens: null, dropped: 0 };
  }

  const baselineItems = pool.filter(f => baselineIds.has(f.id));
  for (const f of baselineItems) exactCounts.set(f, fragmentTokens(f));
  const baseline    = verifyExactBudget(baselineItems, { budget, scoreOf });
  const baseSet     = new Set(baseline.kept);
  const baseIds     = new Set(baseline.kept.map(f => f.id));
  const asBaseline  = (strategy, dropped) => ({ selectedIds: baseIds, strategy, tokens: baseline.tokens, dropped });

  if (pool.length > poolLimit) return asBaseline("baseline-only", baseline.dropped.length);

  const selection = selectWithinBudget(pool, { budget, scoreOf, baselineIds: baseIds, tokensOf: f => estimateTokens(f, exactCounts) });
  const picked    = pool.filter(f => selection.selectedIds.has(f.id));
  const verified  = verifyExactBudget(picked, { budget, scoreOf, protectedItems: baseSet });
  if (exactScoreSum(verified.kept, scoreOf) < exactScoreSum(baseline.kept, scoreOf)) {
    return asBaseline("baseline-fallback", verified.dropped.length);
  }
  return {
    selectedIds: new Set(verified.kept.map(f => f.id)),
    strategy   : selection.strategy,
    tokens     : verified.tokens,
    dropped    : verified.dropped.length
  };
}

/**
 * 저장된 토큰 수를 후보에 붙인다(_storedTokens). estimated_tokens 속성이 있는 파편은 묻지 않는다.
 * loader가 없으면 아무것도 하지 않는다. loader의 오류는 호출자에게 그대로 전한다.
 *
 * @param {Object[]} fragments
 * @param {((ids: string[]) => Promise<Map<string, number>>)|null} loader
 * @returns {Promise<void>}
 */
export async function attachStoredTokens(fragments, loader) {
  if (typeof loader !== "function") return;
  const ids = fragments.filter(f => !f.estimated_tokens).map(f => f.id);
  if (ids.length === 0) return;
  const counts = await loader(ids);
  for (const f of fragments) {
    if (counts.has(f.id)) f._storedTokens = counts.get(f.id);
  }
}

/**
 * recall 예산 선택의 후보와 기준 집합. ordered는 search()가 절단에 쓰는 순서다.
 * superseded(includeSuperseded가 아닐 때)를 뺀 후보의 정확한 토큰 합이 예산 이하이면 상한 없이 전부가 후보이고
 * 기준 집합도 전부다. 넘으면 기준 집합은 추정값(estimateTokens)으로 계산한 검색 순서 절단이고, 후보는 앞
 * limit건에 상한 밖 기준 파편을 검색 순서대로 더한 목록이다.
 *
 * @param {Object[]} ordered
 * @param {{budget: number, includeSuperseded?: boolean, limit?: number, exactCounts?: Map<Object, number>}} opts
 *   exactCounts: 이 요청에서 센 정확한 수를 담는 Map(selectForRecall에 그대로 넘긴다)
 * @returns {{candidates: Object[], baselineIds: Set<*>}}
 */
export function partitionCandidates(ordered, { budget, includeSuperseded = false, limit = RANK_CANDIDATE_LIMIT, exactCounts = new Map() }) {
  const isCurrent = f => includeSuperseded || !f.valid_to;
  const current   = ordered.filter(isCurrent);
  if (!exceedsBudget(current, budget, exactCounts)) {
    return { candidates: current, baselineIds: new Set(current.map(f => f.id)) };
  }
  /** 절단은 superseded를 포함한 순서로 하므로 그 앞부분도 예산을 넘을 때까지 정확히 센다 */
  countPrefixExactly(ordered, budget, exactCounts);
  const baseline  = trimInSearchOrder(ordered, budget, undefined, f => estimateTokens(f, exactCounts)).filter(isCurrent);
  const capped    = ordered.slice(0, limit);
  const cappedIds = new Set(capped.map(f => f.id));
  return {
    candidates : [...capped.filter(isCurrent), ...baseline.filter(f => !cappedIds.has(f.id))],
    baselineIds: new Set(baseline.map(f => f.id))
  };
}

/**
 * 파편의 구획.
 *
 * @param {Object} fragment
 * @returns {"exact"|"supplement"|"linked"|"search"}
 */
export function sectionOf(fragment) {
  if (fragment._kwExact === true)      return "exact";
  if (fragment._kwSupplement === true) return "supplement";
  if (fragment._source === "linked")   return "linked";
  return "search";
}

/**
 * 두 파편의 keywords 겹침 비율(교집합 수 / 큰 쪽의 keywords 수). 한쪽이라도 keywords가 없으면 0.
 *
 * @param {Object} a
 * @param {Object} b
 * @returns {number}
 */
export function keywordOverlap(a, b) {
  if (!a.keywords?.length || !b.keywords?.length) return 0;
  const setA      = new Set(a.keywords);
  const intersect = b.keywords.filter(k => setA.has(k)).length;
  return intersect / Math.max(a.keywords.length, b.keywords.length);
}

/**
 * MMR 유사도. 두 파편 모두 similarity가 있을 때만 keywords 겹침 비율이고, 그 밖에는 0이다.
 *
 * @param {Object} a
 * @param {Object} b
 * @returns {number}
 */
export function pairSimilarity(a, b) {
  if (a.similarity === undefined || b.similarity === undefined) return 0;
  return keywordOverlap(a, b);
}

/**
 * 검색 순서 절단. 태그가 없으면 첫 초과에서 멈추는 앞부분 절단이고, 태그가 있으면 정확 일치는
 * 예산의 exactSlotShare까지, keywords 보조는 semanticSlotShare까지 먼저 확보한 뒤 남은 예산을
 * 순서대로 채운다. 반환은 입력 순서를 유지한다.
 *
 * @param {Object[]} fragments 검색 순서
 * @param {number}   tokenBudget
 * @param {{exactSlotShare?: number, semanticSlotShare?: number}} [ranking]
 * @param {(fragment: Object) => number} [tokensOf] 토큰 수(기본: 정확한 수 fragmentTokens)
 * @returns {Object[]}
 */
export function trimInSearchOrder(fragments, tokenBudget, ranking = MEMORY_CONFIG.ranking ?? {}, tokensOf = fragmentTokens) {
  const { exactSlotShare = 0.5, semanticSlotShare = 0.25 } = ranking;

  const hasTags = fragments.some(f => f._kwExact === true || f._kwSupplement === true);
  if (!hasTags) {
    const result   = [];
    let usedTokens = 0;
    for (const f of fragments) {
      const c = tokensOf(f);
      if (usedTokens + c > tokenBudget) break;
      usedTokens += c;
      result.push(f);
    }
    return result;
  }

  /** 1단계: 정확 일치를 exactSlotShare 상한까지 */
  const picked = new Set();
  let used     = 0;
  for (const f of fragments) {
    if (f._kwExact !== true) continue;
    const c = tokensOf(f);
    if (used + c > tokenBudget * exactSlotShare) break;
    used += c; picked.add(f.id);
  }
  /** 2단계: keywords 보조를 semanticSlotShare 몫까지 */
  let semUsed = 0;
  for (const f of fragments) {
    if (picked.has(f.id) || f._kwSupplement !== true) continue;
    const c = tokensOf(f);
    if (semUsed + c > tokenBudget * semanticSlotShare) break;
    if (used + c > tokenBudget) break;
    used += c; semUsed += c; picked.add(f.id);
  }
  /** 3단계: 남은 예산을 순서대로 */
  for (const f of fragments) {
    if (picked.has(f.id)) continue;
    const c = tokensOf(f);
    if (used + c > tokenBudget) continue;
    used += c; picked.add(f.id);
  }
  return fragments.filter(f => picked.has(f.id));
}

/**
 * 동점 순서: 최종 점수 내림차순, id 오름차순.
 *
 * @param {{score: number, key: string}} a
 * @param {{score: number, key: string}} b
 * @returns {number}
 */
function byScoreThenId(a, b) {
  if (a.score !== b.score) return b.score - a.score;
  if (a.key === b.key) return 0;
  return a.key < b.key ? -1 : 1;
}

/**
 * 두 항목의 MMR 유사도. pairSimilarity(a.fragment, b.fragment)와 같은 값이며, a의 keywords 집합을
 * 항목을 만들 때 한 번만 만든다.
 *
 * @param {{fragment: Object, kwSet: Set<string>|null}} a
 * @param {{fragment: Object, kwSet: Set<string>|null}} b
 * @returns {number}
 */
function itemSimilarity(a, b) {
  if (a.kwSet === null || b.kwSet === null) return 0;
  const keywords = b.fragment.keywords;
  let   intersect = 0;
  for (const k of keywords) if (a.kwSet.has(k)) intersect++;
  return intersect / Math.max(a.fragment.keywords.length, keywords.length);
}

/**
 * 시작 집합에 구획 단계와 채움 단계를 적용한 해.
 *
 * @param {Object[]} items  {index, fragment, key, tokens, score, section, kwSet}
 * @param {number}   budget
 * @param {Object[]} seed   시작 집합(예산 이하)
 * @param {number}   lambda
 * @returns {{chosen: Object[], score: number, tokens: number}}
 */
function buildSolution(items, budget, seed, lambda) {
  const chosen = [];
  const taken  = new Uint8Array(items.length);
  const maxSim = new Float64Array(items.length);
  let   used   = 0;

  const take = (item) => {
    chosen.push(item);
    taken[item.index] = 1;
    used  += item.tokens;
    if (item.kwSet === null) return;
    for (const other of items) {
      if (taken[other.index] === 1) continue;
      const sim = itemSimilarity(other, item);
      if (sim > maxSim[other.index]) maxSim[other.index] = sim;
    }
  };
  const fits = (item) => taken[item.index] === 0 && used + item.tokens <= budget;

  for (const item of seed) take(item);

  const represented = new Set(chosen.map(item => item.section));
  for (const section of SECTION_ORDER) {
    if (represented.has(section)) continue;
    let best = null;
    for (const item of items) {
      if (item.section !== section || item.score <= 0 || !fits(item)) continue;
      if (best === null || byScoreThenId(item, best) < 0) best = item;
    }
    if (best) take(best);
  }

  for (;;) {
    let best    = null;
    let bestKey = -Infinity;
    for (const item of items) {
      if (!fits(item)) continue;
      const gain = lambda * item.score - (1 - lambda) * maxSim[item.index];
      const key  = gain / Math.max(item.tokens, 1);
      if (best === null || key > bestKey || (key === bestKey && byScoreThenId(item, best) < 0)) {
        best    = item;
        bestKey = key;
      }
    }
    if (best === null) break;
    take(best);
  }

  return { chosen, score: scoreSumById(chosen), tokens: used };
}

/**
 * 점수 합. id 순서로 더해 입력 순서와 무관하게 같은 값이 되게 한다.
 *
 * @param {Array<{key: string, score: number}>} items
 * @returns {number}
 */
function scoreSumById(items) {
  return [...items]
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .reduce((sum, item) => sum + item.score, 0);
}

/**
 * 최종 점수를 매긴 후보에서 토큰 예산 안의 집합을 고른다. 규칙은 머리말을 따른다.
 *
 * @param {Object[]} pool 검색 후보와 연결 파편(id 중복 없음)
 * @param {Object}   opts
 * @param {number}   opts.budget       토큰 예산
 * @param {(fragment: Object) => number} opts.scoreOf 최종 점수
 * @param {Set<*>}   [opts.baselineIds] 검색 순서 절단이 고른 id
 * @param {number}   [opts.lambda]      MMR 관련성 가중치
 * @param {(fragment: Object) => number} [opts.tokensOf] 토큰 수(기본: 정확한 수 fragmentTokens)
 * @returns {{selectedIds: Set<*>, strategy: "all"|"greedy"|"baseline"|"baseline-only", tokens: number, score: number|null}}
 */
export function selectWithinBudget(pool, { budget, scoreOf, baselineIds = new Set(), lambda = MMR_LAMBDA, tokensOf = fragmentTokens }) {
  if (pool.length > SELECTION_POOL_MAX) {
    const kept = pool.filter(f => baselineIds.has(f.id));
    return { selectedIds: new Set(kept.map(f => f.id)), strategy: "baseline-only", tokens: kept.reduce((sum, f) => sum + tokensOf(f), 0), score: null };
  }
  const items = pool.map((fragment, index) => {
    const raw = Number(scoreOf(fragment));
    return {
      index,
      fragment,
      key    : String(fragment.id),
      tokens : tokensOf(fragment),
      score  : Number.isFinite(raw) ? raw : 0,
      section: sectionOf(fragment),
      /** MMR 유사도 입력: similarity와 keywords가 모두 있어야 한다(없으면 서로 다른 것으로 본다) */
      kwSet  : fragment.similarity !== undefined && fragment.keywords?.length ? new Set(fragment.keywords) : null
    };
  });

  const totalTokens = items.reduce((sum, item) => sum + item.tokens, 0);
  if (totalTokens <= budget) {
    return {
      selectedIds: new Set(pool.map(f => f.id)),
      strategy   : "all",
      tokens     : totalTokens,
      score      : scoreSumById(items)
    };
  }

  const greedy     = buildSolution(items, budget, [], lambda);
  const seed       = items.filter(item => baselineIds.has(item.fragment.id));
  const seedTokens = seed.reduce((sum, item) => sum + item.tokens, 0);
  const baseline   = seed.length > 0 && seedTokens <= budget ? buildSolution(items, budget, seed, lambda) : null;
  const useBase    = baseline !== null && baseline.score > greedy.score;
  const picked   = useBase ? baseline : greedy;

  return {
    selectedIds: new Set(picked.chosen.map(item => item.fragment.id)),
    strategy   : useBase ? "baseline" : "greedy",
    tokens     : picked.tokens,
    score      : picked.score
  };
}
