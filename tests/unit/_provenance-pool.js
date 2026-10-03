/**
 * 출처 열 조회에 답하는 시험용 풀
 *
 * 작성자: 최진호
 * 작성일: 2026-10-04
 *
 * MEMENTO_PROVENANCE=on(기본)에서 context는 core 후보의 출처 열을 한 번 조회하고, 조회 결과에 없는
 * 후보를 주입에서 뺀다. 이 도우미는 그 조회(f.trust_tier를 읽는 문장)에 요청한 id마다 출처 열이
 * NULL인 행(기존 행과 같은 등급 2)을 돌려주고, 그 밖의 문장은 넘겨받은 처리기에 맡긴다.
 */

/**
 * @param {(sql: string, params: unknown[]) => Promise<{rows: object[]}>} handler
 * @param {Record<string, {origin?: string|null, trust_tier?: number|null}>} [overrides] - id별 출처 열
 * @returns {{query: Function}}
 */
export function poolWithProvenance(handler, overrides = {}) {
  return {
    query: async (sql, params = []) => {
      if (/\bf\.trust_tier\b/.test(sql)) {
        const ids = Array.isArray(params[0]) ? params[0] : [];
        return { rows: ids.map(id => ({ id, source: null, origin: null, trust_tier: null, ...(overrides[id] ?? {}) })) };
      }
      return handler(sql, params);
    }
  };
}
