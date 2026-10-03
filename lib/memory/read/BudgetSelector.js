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
 *    쪽을 고른다(같으면 탐욕해).
 *      탐욕해: 빈 집합에서 시작한다.
 *      기준해: 검색 순서 절단(trimInSearchOrder)이 고른 집합에서 시작한다.
 *    두 해 모두 같은 두 단계를 거친다.
 *      구획 단계: 구획(exact, supplement, linked, search) 순서로, 아직 고른 항목이 없는 구획마다
 *        남은 예산에 들어가는 항목 가운데 최종 점수가 가장 높은 것 하나를 고른다.
 *      채움 단계: 남은 예산에 들어가는 항목 가운데 MMR 이득을 토큰 수(최소 1)로 나눈 값이 가장 큰
 *        항목을 하나씩 고른다. 이득은 lambda * 점수 - (1 - lambda) * (이미 고른 항목과의 최대 유사도)다.
 *    동점은 최종 점수 내림차순, id 오름차순으로 정한다.
 *    최종 점수는 0 이상이므로(rerankerScore는 sigmoid 값, 복합 점수와 lexical 가산은 0 이상, workspace
 *    감쇠는 양수 배율) 기준해의 점수 합은 검색 순서 절단의 점수 합 이상이고, 고른 해도 그 이상이다.
 *
 * MMR 유사도는 두 파편 모두 임베딩 유사도(similarity)를 가진 경우에만 keywords 겹침 비율로 계산하고,
 * 어느 한쪽이라도 similarity나 keywords가 없으면 0(서로 다른 것)으로 본다.
 *
 * 비용: 후보 n은 검색 후보 상한 RANK_CANDIDATE_LIMIT(200)과 연결 파편 상한(linkedFragmentLimit)의 합 이하다.
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

/**
 * 파편의 토큰 수. estimated_tokens가 있으면 그 값을, 없으면 본문을 센다.
 *
 * @param {Object} fragment
 * @returns {number}
 */
export function fragmentTokens(fragment) {
  return fragment.estimated_tokens || countTokens(fragment.content || "");
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
 * @returns {Object[]}
 */
export function trimInSearchOrder(fragments, tokenBudget, ranking = MEMORY_CONFIG.ranking ?? {}) {
  const { exactSlotShare = 0.5, semanticSlotShare = 0.25 } = ranking;

  const hasTags = fragments.some(f => f._kwExact === true || f._kwSupplement === true);
  if (!hasTags) {
    const result   = [];
    let usedTokens = 0;
    for (const f of fragments) {
      const c = fragmentTokens(f);
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
    const c = fragmentTokens(f);
    if (used + c > tokenBudget * exactSlotShare) break;
    used += c; picked.add(f.id);
  }
  /** 2단계: keywords 보조를 semanticSlotShare 몫까지 */
  let semUsed = 0;
  for (const f of fragments) {
    if (picked.has(f.id) || f._kwSupplement !== true) continue;
    const c = fragmentTokens(f);
    if (semUsed + c > tokenBudget * semanticSlotShare) break;
    if (used + c > tokenBudget) break;
    used += c; semUsed += c; picked.add(f.id);
  }
  /** 3단계: 남은 예산을 순서대로 */
  for (const f of fragments) {
    if (picked.has(f.id)) continue;
    const c = fragmentTokens(f);
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
 * 시작 집합에 구획 단계와 채움 단계를 적용한 해.
 *
 * @param {Object[]} items  {fragment, key, tokens, score, section}
 * @param {number}   budget
 * @param {Object[]} seed   시작 집합(예산 이하)
 * @param {number}   lambda
 * @returns {{chosen: Object[], score: number, tokens: number}}
 */
function buildSolution(items, budget, seed, lambda) {
  const chosen = [];
  const taken  = new Set();
  const maxSim = new Map(items.map(item => [item, 0]));
  let   used   = 0;
  let   score  = 0;

  const take = (item) => {
    chosen.push(item);
    taken.add(item);
    used  += item.tokens;
    score += item.score;
    for (const other of items) {
      if (taken.has(other)) continue;
      const sim = pairSimilarity(other.fragment, item.fragment);
      if (sim > maxSim.get(other)) maxSim.set(other, sim);
    }
  };
  const fits = (item) => !taken.has(item) && used + item.tokens <= budget;

  for (const item of seed) take(item);

  const represented = new Set(chosen.map(item => item.section));
  for (const section of SECTION_ORDER) {
    if (represented.has(section)) continue;
    const best = items.filter(item => item.section === section && fits(item)).sort(byScoreThenId)[0];
    if (best) take(best);
  }

  for (;;) {
    let best    = null;
    let bestKey = -Infinity;
    for (const item of items) {
      if (!fits(item)) continue;
      const gain = lambda * item.score - (1 - lambda) * maxSim.get(item);
      const key  = gain / Math.max(item.tokens, 1);
      if (best === null || key > bestKey || (key === bestKey && byScoreThenId(item, best) < 0)) {
        best    = item;
        bestKey = key;
      }
    }
    if (best === null) break;
    take(best);
  }

  return { chosen, score, tokens: used };
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
 * @returns {{selectedIds: Set<*>, strategy: "all"|"greedy"|"baseline", tokens: number, score: number}}
 */
export function selectWithinBudget(pool, { budget, scoreOf, baselineIds = new Set(), lambda = MMR_LAMBDA }) {
  const items = pool.map(fragment => {
    const raw = Number(scoreOf(fragment));
    return {
      fragment,
      key    : String(fragment.id),
      tokens : fragmentTokens(fragment),
      score  : Number.isFinite(raw) ? raw : 0,
      section: sectionOf(fragment)
    };
  });

  const totalTokens = items.reduce((sum, item) => sum + item.tokens, 0);
  if (totalTokens <= budget) {
    return {
      selectedIds: new Set(pool.map(f => f.id)),
      strategy   : "all",
      tokens     : totalTokens,
      score      : items.reduce((sum, item) => sum + item.score, 0)
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
