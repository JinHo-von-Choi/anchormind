/**
 * ContextTrust - context 주입의 신뢰 등급 제외와 출처 주석 도우미
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * MEMENTO_PROVENANCE=on에서 context는 신뢰 등급 1 이하 파편을 ANCHOR와 CORE 주입에서 뺀다.
 * 앵커는 조회 SQL의 술어로, core는 회상 결과를 별도 조회한 등급으로 거른다. 두 판정은
 * lib/memory/provenance.js의 같은 문턱(isInjectable, injectableTierSql)을 쓴다.
 * DB, 설정, 환경 변수에 닿지 않는 순수 함수만 둔다.
 */

import { injectableTierSql, isInjectable } from "../provenance.js";

/**
 * 앵커 조회 SQL에 덧붙일 조각. 꺼져 있으면 빈 문자열이라 문장이 바뀌지 않는다.
 *
 * @param {boolean} enabled - MEMENTO_PROVENANCE
 * @returns {{select: string, filter: string}} select는 SELECT 목록 뒤, filter는 WHERE 절 끝에 붙인다
 */
export function anchorProvenanceSql(enabled) {
  if (!enabled) return { select: "", filter: "" };
  return { select: ", origin", filter: `AND ${injectableTierSql("trust_tier")}` };
}

/**
 * 유형별 core 후보에서 주입 대상이 아닌 파편을 뺀 새 맵을 만든다. 등급을 모르는 파편은 2로 본다.
 *
 * @param {Map<string, object[]>} typeFragMap
 * @param {Map<string, {trustTier?: number|null}>} provenance - 파편 id별 출처 열
 * @returns {Map<string, object[]>}
 */
export function dropLowTrust(typeFragMap, provenance) {
  const result = new Map();
  for (const [type, fragments] of typeFragMap) {
    result.set(type, (fragments ?? []).filter(f => isInjectable({ trust_tier: provenance.get(f?.id)?.trustTier })));
  }
  return result;
}

/**
 * 주석 필드에 출처를 더한다. 출처가 없으면 원래 객체를 돌려준다.
 *
 * @param {object} meta - 주석에 쓸 필드를 가진 객체
 * @param {{origin?: string|null}|undefined} entry
 * @returns {object}
 */
export function withOriginMeta(meta, entry) {
  return entry?.origin ? { ...meta, origin: entry.origin } : meta;
}
