/**
 * AuditProvenance - 모순 감사 기록의 출처 문맥
 *
 * 작성자: 최진호
 * 작성일: 2026-10-04
 *
 * 모순 해소는 대체된 파편의 본문 일부를 담은 감사 파편을 remember로 남긴다. MEMENTO_PROVENANCE=on이면
 * 감사 파편의 키 상한을 두 원본 등급 중 낮은 값으로 정해(derivedTrustCap), 등급 1 이하 원본의 본문이
 * 등급 2 파편으로 주입되지 않게 한다. 원본 등급 조회가 실패하면 낮음(1)으로 본다.
 */

import { provenanceEnabled }                from "../../config.js";
import { logWarn }                          from "../../logger.js";
import { derivedTrustCap, TRUST_TIER }      from "../provenance.js";

/** 감사 파편의 관측 클라이언트 이름 */
const AUDIT_CLIENT = "internal";

/**
 * remember 인자에 펼칠 출처 문맥. 꺼져 있으면 빈 객체다.
 *
 * @param {{getTrustTiers: (ids: string[]) => Promise<Map<string, number|null>>}} store
 * @param {string[]} parentIds - 승자와 패자 파편 id
 * @returns {Promise<{_provenance?: {clientName: string, trustCap: number}}>}
 */
export async function auditProvenance(store, parentIds) {
  if (!provenanceEnabled()) return {};
  try {
    const tiers = await store.getTrustTiers(parentIds);
    return { _provenance: { clientName: AUDIT_CLIENT, trustCap: derivedTrustCap(parentIds.map(id => tiers.get(id))) } };
  } catch (err) {
    logWarn(`[AuditProvenance] parent trust lookup failed, audit capped at low: ${err.message}`);
    return { _provenance: { clientName: AUDIT_CLIENT, trustCap: TRUST_TIER.LOW } };
  }
}
