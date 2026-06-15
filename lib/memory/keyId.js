/**
 * keyId.js — normalizeKeyId / extractRequestCtx 공용 모듈
 *
 * 작성자: 최진호
 * 작성일: 2026-04-19
 * 수정일: 2026-06-15 (extractRequestCtx 추가)
 *
 * normalizeKeyId: 3개 사이트(CbrEligibility, ClaimStore, SearchParamAdaptor)의
 *   normalizeKeyId 구현을 단일 모듈로 통합한다.
 *   각 모드는 사이트 고유의 반환 계약을 그대로 유지하며,
 *   호출자는 mode 옵션을 임의로 변경하면 안 된다.
 *
 * extractRequestCtx: MemoryRememberer / MemoryRecaller / BatchRememberProcessor에서
 *   반복되는 agentId / keyId / groupKeyIds 3줄 추출 블록을 통합한다.
 */

/**
 * 요청 params에서 {agentId, keyId, groupKeyIds}를 추출한다.
 *
 * opts.groupKeyIdsFallback 별 groupKeyIds 폴백:
 *
 * 'null' (기본값):
 *   - _groupKeyIds ?? (keyId ? [keyId] : null)
 *   - remember / recall / forget 경로 사용
 *
 * 'empty':
 *   - _groupKeyIds ?? (keyId ? [keyId] : [])
 *   - fragmentHistory / graphExplore 경로 사용
 *
 * 'amend':
 *   - _groupKeyIds ?? params.groupKeyIds ?? []
 *   - amend 경로 전용 (groupKeyIds 공개 파라미터 폴백 포함)
 *
 * @param {Object} params
 * @param {{ groupKeyIdsFallback?: 'null' | 'empty' | 'amend' }} opts
 * @returns {{ agentId: string, keyId: string|null, groupKeyIds: string[]|null }}
 */
export function extractRequestCtx(params, opts = {}) {
  const agentId = params.agentId || "default";
  const keyId   = params._keyId ?? null;

  const mode = opts.groupKeyIdsFallback ?? 'null';
  let groupKeyIds;
  if (mode === 'empty') {
    groupKeyIds = params._groupKeyIds ?? (keyId ? [keyId] : []);
  } else if (mode === 'amend') {
    groupKeyIds = params._groupKeyIds ?? params.groupKeyIds ?? [];
  } else {
    groupKeyIds = params._groupKeyIds ?? (keyId ? [keyId] : null);
  }

  return { agentId, keyId, groupKeyIds };
}

/**
 * keyId를 사이트별 계약에 따라 정규화한다.
 *
 * opts.mode 별 반환 계약:
 *
 * 'cbr' (CbrEligibility):
 *   - 배열 입력 → 첫 원소 ?? null (길이 0이면 null)
 *   - null / undefined → null
 *   - 나머지 → 원본 그대로
 *
 * 'claim' (ClaimStore):
 *   - null / undefined / '' → null
 *   - 배열 → 배열 그대로 반환 (배열은 지원하지 않으므로 후속 가드에서 거부)
 *   - 공백 포함 나머지 → 원본 그대로
 *
 * 'search' (SearchParamAdaptor):
 *   - null / undefined → '-1' sentinel (NOT NULL 스키마 대응)
 *   - 배열 → 첫 원소 ?? null, 그 결과가 null이면 '-1'
 *   - 빈 배열 → '-1'
 *   - 나머지 → String() 캐스팅
 *
 * @param {*} raw - 정규화할 keyId 원본 값
 * @param {{ mode: 'cbr' | 'claim' | 'search' }} opts
 * @returns {string | string[] | null}
 */
export function normalizeKeyId(raw, opts = {}) {
  const { mode } = opts;

  if (mode === 'cbr') {
    if (Array.isArray(raw)) {
      return raw.length > 0 ? (raw[0] ?? null) : null;
    }
    return raw ?? null;
  }

  if (mode === 'claim') {
    if (raw === undefined || raw === null || raw === '') return null;
    return raw;
  }

  if (mode === 'search') {
    if (Array.isArray(raw)) {
      const first = raw[0] ?? null;
      if (first == null) return '-1';
      return String(first);
    }
    if (raw == null) return '-1';
    return String(raw);
  }

  throw new Error(`normalizeKeyId: unknown mode '${mode}'. mode는 'cbr'|'claim'|'search' 중 하나여야 한다.`);
}
