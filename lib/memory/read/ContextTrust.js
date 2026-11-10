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

import { injectableTierSql, isInjectable, isLowAuthorityDirective } from "../provenance.js";
import { isSupported, supportedSql }       from "../write/Lineage.js";

/**
 * 앵커 조회 SQL에 덧붙일 조각. 꺼져 있으면 출처 열을 읽지 않고 등급 술어도 붙이지 않는다.
 *
 * 근거를 잃은 파생 파편(revoked, stale) 제외는 스위치와 무관하게 붙는다.
 *
 * @param {boolean} enabled - MEMENTO_PROVENANCE
 * @returns {{select: string, filter: string}} select는 SELECT 목록 뒤, filter는 WHERE 절 끝에 붙인다
 */
export function anchorProvenanceSql(enabled) {
  if (!enabled) return { select: "", filter: `AND ${supportedSql()}` };
  return { select: ", origin", filter: `AND ${injectableTierSql("trust_tier")} AND ${supportedSql()}` };
}

/**
 * 유형별 core 후보에서 주입 대상만 남긴 새 맵을 만든다. 근거 상태가 revoked, stale인 파생 파편은 언제나 뺀다.
 * trust이면(MEMENTO_PROVENANCE=on) 출처 조회 결과에 없는 파편(조회 실패 포함)은 등급을 알 수 없으므로 빼고,
 * 등급 1 이하도 뺀다. 조회 결과의 trustTier NULL은 2로 본다. trust가 아니면 조회 결과에 없는 파편은 남긴다.
 *
 * @param {Map<string, object[]>} typeFragMap
 * @param {Map<string, {trustTier?: number|null, supportState?: string|null}>} provenance - 파편 id별 출처 열
 * @param {{trust?: boolean}} [options]
 * @returns {{typeFragMap: Map<string, object[]>, excluded: {lowTrust: number, missing: number, unsupported: number}}}
 */
export function dropLowTrust(typeFragMap, provenance, { trust = true } = {}) {
  const result   = new Map();
  const excluded = { lowTrust: 0, missing: 0, unsupported: 0 };
  for (const [type, fragments] of typeFragMap) {
    result.set(type, (fragments ?? []).filter(f => {
      const entry = provenance.get(f?.id);
      if (entry === undefined) {
        if (!trust) return true;
        excluded.missing += 1;
        return false;
      }
      if (!isSupported({ support_state: entry.supportState })) { excluded.unsupported += 1; return false; }
      if (trust && !isInjectable({ trust_tier: entry.trustTier })) { excluded.lowTrust += 1; return false; }
      return true;
    }));
  }
  return { typeFragMap: result, excluded };
}

/**
 * 출처 권한이 낮은 행동 규칙 파편(lib/memory/provenance.js isLowAuthorityDirective)을 찾는다. enforce면 빼고, warn이면
 * 그대로 두고 센다. off면 판정하지 않는다. 유형은 후보 파편에서, 출처와 검토 상태는 출처 조회 결과에서 읽는다.
 *
 * @param {Map<string, object[]>} typeFragMap
 * @param {Map<string, {origin?: string|null, qualityVerified?: boolean, reviewState?: string|null}>} provenance
 * @param {"off"|"warn"|"enforce"} mode - MEMENTO_DIRECTIVE_ORIGIN_GATE
 * @returns {{typeFragMap: Map<string, object[]>, flagged: number}}
 */
export function gateDirectives(typeFragMap, provenance, mode) {
  if (mode !== "warn" && mode !== "enforce") return { typeFragMap, flagged: 0 };
  const result = new Map();
  let flagged  = 0;
  for (const [type, fragments] of typeFragMap) {
    result.set(type, (fragments ?? []).filter(f => {
      const entry = provenance.get(f?.id);
      const low   = entry !== undefined && isLowAuthorityDirective({
        type: f?.type, origin: entry.origin, quality_verified: entry.qualityVerified, review_state: entry.reviewState
      });
      if (!low) return true;
      flagged += 1;
      return mode !== "enforce";
    }));
  }
  return { typeFragMap: result, flagged };
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
