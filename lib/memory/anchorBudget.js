/**
 * context 앵커 토큰 예산 판정
 *
 * 작성자: 최진호
 * 작성일: 2026-10-20
 *
 * 앵커는 context의 tokenBudget 절삭에서 빠지고 매 호출 주입되므로, 하나를 더하면 그만큼 매번 비용이 든다.
 * 이 모듈은 주입되는 앵커 집합의 토큰 합을 예산과 비교하고, 넘으면 순위가 가장 낮은 앵커부터 내릴 후보로
 * 고른다. DB와 환경 변수를 읽지 않는 순수 함수다.
 *   anchorBudgetReport     context가 실제로 주입한 앵커 목록(순위순)의 사용량과 내릴 후보
 *   anchorBudgetForCandidate 새 앵커가 주입 집합에 들어갈 때의 사용량과 내릴 후보
 */

/** 예산을 넘긴 앵커 지정의 경고 규칙 이름 */
export const ANCHOR_BUDGET_RULE = "anchorContextBudgetExceeded";

/** 내릴 후보로 돌려주는 최대 수 */
const MAX_DEMOTE = 5;

/**
 * 순위순 앵커 목록(앞이 높은 순위)에서 합이 예산 이하가 될 때까지 뒤에서부터 고른 id.
 *
 * @param {Array<{id: string, tokens: number}>} ranked
 * @param {number} used
 * @param {number} limit
 * @param {string|null} [keepId] 고르지 않을 id(새로 지정하는 앵커)
 * @returns {string[]}
 */
function demoteFromTail(ranked, used, limit, keepId = null) {
  const out = [];
  let rest  = used;
  for (let i = ranked.length - 1; i >= 0 && rest > limit && out.length < MAX_DEMOTE; i--) {
    if (ranked[i].id === keepId) continue;
    out.push(ranked[i].id);
    rest -= ranked[i].tokens;
  }
  return out;
}

/**
 * context가 주입한 앵커의 토큰 사용량 보고. 예산이 0 이하이면 null.
 *
 * @param {Array<{id: string, content?: string}>} rankedAnchors 주입 순서(순위순) 앵커
 * @param {number} limit
 * @param {(content: string) => number} countTokens
 * @returns {{used: number, limit: number, exceeded: boolean, demote_candidates: string[]}|null}
 */
export function anchorBudgetReport(rankedAnchors, limit, countTokens) {
  if (!(limit > 0)) return null;
  const ranked = rankedAnchors.map(f => ({ id: f.id, tokens: countTokens(f.content || "") }));
  const used   = ranked.reduce((sum, r) => sum + r.tokens, 0);
  const exceeded = used > limit;
  return { used, limit, exceeded, demote_candidates: exceeded ? demoteFromTail(ranked, used, limit) : [] };
}

/**
 * 새 앵커가 지금 주입되는 앵커 집합에 들어갈 때의 판정. 후보가 상위 maxAnchors 안에 들지 못하면 주입되지
 * 않으므로 예산에 영향이 없다. 순위는 context와 같이 importance 내림차순, 같으면 기존 앵커가 앞이다.
 *
 * @param {Object} input
 * @param {Array<{id: string, importance: number, tokens: number}>} input.injected 현재 상위 앵커(순위순)
 * @param {{id?: string|null, importance: number, tokens: number}} input.candidate
 * @param {number} input.maxAnchors
 * @param {number} input.limit
 * @returns {{exceeded: boolean, used: number, demote_candidates: string[]}}
 */
export function anchorBudgetForCandidate({ injected, candidate, maxAnchors, limit }) {
  const others = injected.filter(a => a.id !== candidate.id);
  const at     = others.findIndex(a => (Number(a.importance) || 0) < (Number(candidate.importance) || 0));
  const merged = [...others];
  merged.splice(at === -1 ? merged.length : at, 0, { ...candidate, id: candidate.id ?? null, isCandidate: true });
  const top    = merged.slice(0, Math.max(0, maxAnchors));
  if (!(limit > 0) || !top.some(a => a.isCandidate)) return { exceeded: false, used: 0, demote_candidates: [] };

  const used = top.reduce((sum, a) => sum + (Number(a.tokens) || 0), 0);
  if (used <= limit) return { exceeded: false, used, demote_candidates: [] };
  const ranked = top.map(a => ({ id: a.isCandidate ? "__candidate__" : a.id, tokens: Number(a.tokens) || 0 }));
  return { exceeded: true, used, demote_candidates: demoteFromTail(ranked, used, limit, "__candidate__") };
}
