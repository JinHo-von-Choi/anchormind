/**
 * 분할 자식 검증용 주어 앵커 추출.
 *
 * 형태소 분석기의 고유명사(NNP)·외국어(SL)·한자(SH) 토큰에 코드 식별자와
 * 라틴+한글 혼합 축약 주체(A사, K팀)를 더해, 부모 원문이 말하는 주체 집합을
 * 만든다. 분석기 로드 실패·예외는 모두 빈 배열로 흡수한다(fail-open) —
 * 앵커가 없으면 게이트는 통과로 판정하므로 분할 자체를 막지 않는다.
 *
 * 작성자: 최진호
 * 작성일: 2026-08-06
 */

/** 코드 식별자: camelCase·PascalCase 또는 snake_case (FragmentFactory.extractKeywords와 동일 계약) */
const IDENT = /\b(?:[A-Za-z][a-z0-9]*(?:[A-Z][A-Za-z0-9]*)+|[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+)\b/g;

/** 라틴+한글 혼합 토큰(A사, K팀). 형태소 분석기가 한 토큰으로 잡지 못하는 축약 주체를 보완한다. */
const LATIN_HANGUL = /[A-Za-z]+[가-힣]+/g;

/** 한글 1자 앵커는 우연 일치가 잦아 앵커로 쓰지 않는다. */
function addAnchor(anchors, token) {
  const t = typeof token === "string" ? token.trim() : "";
  if (t.length === 0)                          return;
  if (/[가-힣]/.test(t) && t.length < 2)       return;
  anchors.add(t);
}

/**
 * 원문에서 주어 앵커를 추출한다.
 *
 * MorphemeTokenizer는 함수 내부에서 동적 import한다 — 부팅 시 WASM 상주를 피하고,
 * 분할 stage가 실제로 돌 때만 분석기를 깨우기 위함이다.
 *
 * @param {string} text
 * @param {{maxAnchors?: number}} [options]
 * @returns {Promise<string[]>} 중복 제거·절단된 앵커 목록 (실패 시 빈 배열)
 */
export async function extractSubjectAnchors(text, { maxAnchors = 12 } = {}) {
  if (typeof text !== "string" || text.trim().length === 0) return [];

  const anchors = new Set();

  try {
    const { extractProperNounTokens } = await import("../embedding/MorphemeTokenizer.js");
    const proper = await extractProperNounTokens(text);
    for (const token of proper ?? []) addAnchor(anchors, token);
  } catch {
    /** 분석기 미가용 — 정규식 기반 앵커만으로 진행한다 */
  }

  try {
    for (const m of text.matchAll(IDENT))        addAnchor(anchors, m[0]);
    for (const m of text.matchAll(LATIN_HANGUL)) addAnchor(anchors, m[0]);
  } catch {
    /** 정규식 경로 실패도 앵커 없음으로 흡수 */
  }

  return [...anchors].slice(0, Math.max(0, maxAnchors));
}
