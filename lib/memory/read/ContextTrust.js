/**
 * ContextTrust - context 주입의 신뢰 등급 제외와 출처 주석 도우미
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * MEMENTO_PROVENANCE=on에서 context는 신뢰 등급 1 이하 파편을 ANCHOR와 CORE 주입에서 뺀다.
 * 앵커는 조회 SQL의 술어로, core는 회상 결과를 별도 조회한 등급으로 거른다. core는 등급을 확인하지
 * 못한 파편(조회 실패, 조회 결과에 없는 id)도 뺀다. 두 판정은
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
 * 유형별 core 후보에서 주입 대상만 남긴 새 맵을 만든다. 출처 조회 결과에 없는 파편(조회 실패 포함)은
 * 등급을 알 수 없으므로 뺀다. 조회 결과의 trustTier NULL은 2로 본다.
 *
 * @param {Map<string, object[]>} typeFragMap
 * @param {Map<string, {trustTier?: number|null}>} provenance - 파편 id별 출처 열
 * @returns {{typeFragMap: Map<string, object[]>, excluded: {lowTrust: number, missing: number}}}
 */
export function dropLowTrust(typeFragMap, provenance) {
  const result   = new Map();
  const excluded = { lowTrust: 0, missing: 0 };
  for (const [type, fragments] of typeFragMap) {
    result.set(type, (fragments ?? []).filter(f => {
      const entry = provenance.get(f?.id);
      if (entry === undefined) { excluded.missing += 1; return false; }
      if (!isInjectable({ trust_tier: entry.trustTier })) { excluded.lowTrust += 1; return false; }
      return true;
    }));
  }
  return { typeFragMap: result, excluded };
}

/**
 * core 등급 판정 결과 메타. 조회가 실패하면 partial이고 loadStatus.trust가 false다.
 *
 * @param {boolean} loaded - 출처 조회 성공 여부
 * @param {{lowTrust: number, missing: number}} excluded
 * @returns {{partial: boolean, loadStatus: {trust: boolean}, excluded: {lowTrust: number, missing: number}}}
 */
export function coreTrustSelection(loaded, excluded) {
  return { partial: !loaded, loadStatus: { trust: loaded }, excluded: { ...excluded } };
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
