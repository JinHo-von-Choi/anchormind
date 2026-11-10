/**
 * ContextTrustFilter - context 후보의 출처, 근거 상태, 행동 규칙 출처 판정
 *
 * 작성자: 최진호
 * 작성일: 2026-11-10
 *
 * context가 core와 Learning 후보에 같은 판정을 한다. 후보 id의 출처 열과 근거 상태를 읽고(ProvenanceLoader)
 * ContextTrust의 순수 판정을 적용한 뒤 지표를 남긴다.
 *
 *   근거 상태  원본이 철회돼 support_state가 revoked, stale인 파생 파편은 언제나 뺀다
 *   신뢰 등급  MEMENTO_PROVENANCE=on이면 등급 1 이하와 등급을 확인하지 못한 파편을 뺀다
 *   행동 규칙  MEMENTO_PROVENANCE=on이면 출처 권한이 낮은 preference, procedure에 MEMENTO_DIRECTIVE_ORIGIN_GATE를 적용한다
 *
 * 출처 조회가 실패하면 MEMENTO_PROVENANCE=on은 후보를 모두 빼고(partial), off는 후보를 그대로 둔다.
 */

import { directiveOriginGateMode }  from "../../config.js";
import { logWarn }                  from "../../logger.js";
import { loadFragmentProvenance }   from "./ProvenanceLoader.js";
import { recordCoreTrustExcluded }  from "./provenance-metrics.js";
import { coreTrustSelection, dropLowTrust, gateDirectives } from "./ContextTrust.js";

/**
 * 출처 권한이 낮은 행동 규칙 파편에 MEMENTO_DIRECTIVE_ORIGIN_GATE를 적용하고 지표를 남긴다.
 *
 * @param {Map<string, object[]>} typeFragMap
 * @param {Map<string, object>} provenance
 * @returns {Map<string, object[]>}
 */
function applyDirectiveGate(typeFragMap, provenance) {
  const mode = directiveOriginGateMode();
  const { typeFragMap: kept, flagged } = gateDirectives(typeFragMap, provenance, mode);
  recordCoreTrustExcluded(mode === "enforce" ? "directive_origin" : "directive_origin_warn", flagged);
  return kept;
}

/**
 * core 후보에서 주입 대상만 남긴다. withOrigin이면 판정 메타(selection)와 출처 맵(주석용)도 돌려준다.
 * 풀이 없는 저장소는 출처 열이 없으므로 거르지 않는다.
 *
 * @param {Map<string, object[]>} typeFragMap
 * @param {object} scope - 회상과 같은 조회 범위
 * @param {boolean} withOrigin - MEMENTO_PROVENANCE
 * @param {() => {query: Function}|null} getPool
 * @returns {Promise<{typeFragMap: Map<string, object[]>, provenance: Map<string, object>, selection: object|null}>}
 */
export async function filterCoreByTrust(typeFragMap, scope, withOrigin, getPool) {
  const ids = [...typeFragMap.values()].flat().map(f => f?.id);
  let provenance;
  let loaded = true;
  try {
    provenance = await loadFragmentProvenance(ids, scope, getPool);
  } catch (err) {
    if (!withOrigin) {
      logWarn(`[ContextBuilder] core support lookup failed, candidates kept: ${err.message}`);
      return { typeFragMap, provenance: new Map(), selection: null };
    }
    logWarn(`[ContextBuilder] core provenance lookup failed, core candidates excluded: ${err.message}`);
    provenance = new Map();
    loaded     = false;
  }
  if (provenance === null) return { typeFragMap, provenance: new Map(), selection: null };
  if (!withOrigin) {
    return { typeFragMap: dropLowTrust(typeFragMap, provenance, { trust: false }).typeFragMap, provenance: new Map(), selection: null };
  }

  const { typeFragMap: trusted, excluded } = dropLowTrust(typeFragMap, provenance);
  const kept = applyDirectiveGate(trusted, provenance);
  recordCoreTrustExcluded("unsupported", excluded.unsupported);
  recordCoreTrustExcluded("low_trust", excluded.lowTrust);
  if (loaded) recordCoreTrustExcluded("missing", excluded.missing);
  else recordCoreTrustExcluded("lookup_failed", excluded.missing);
  return { typeFragMap: kept, provenance, selection: coreTrustSelection(loaded, excluded) };
}

/**
 * 파편 목록(Learning 구획)에 core와 같은 판정을 한다.
 *
 * @param {object[]} fragments
 * @param {object} scope - 회상과 같은 조회 범위
 * @param {boolean} withOrigin - MEMENTO_PROVENANCE
 * @param {() => {query: Function}|null} getPool
 * @returns {Promise<object[]>}
 */
export async function filterListByTrust(fragments, scope, withOrigin, getPool) {
  let provenance;
  try {
    provenance = await loadFragmentProvenance(fragments.map(f => f?.id), scope, getPool);
  } catch (err) {
    logWarn(`[ContextBuilder] learning provenance lookup failed: ${err.message}`);
    return withOrigin ? [] : fragments;
  }
  if (provenance === null) return fragments;
  const kept = dropLowTrust(new Map([["learning", fragments]]), provenance, { trust: withOrigin }).typeFragMap;
  return (withOrigin ? applyDirectiveGate(kept, provenance) : kept).get("learning");
}
