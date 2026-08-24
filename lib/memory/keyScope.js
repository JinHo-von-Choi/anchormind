/**
 * 키 격리 WHERE 절을 생성하고 바인딩을 params에 append한다.
 * 정답 패턴: 스칼라 keyId는 IS NOT DISTINCT FROM, 그룹 배열은 = ANY().
 * keyId가 null(마스터)이면 빈 절을 반환하여 전체 접근을 허용한다.
 *
 * 전역(key_id IS NULL) 파편은 의도적으로 매칭하지 않는다 (FragmentReader.getById 정답형과 일치).
 *
 * @param {Array}       params  - 바인딩 배열 (in-place로 push됨)
 * @param {string}      column  - 비교 대상 컬럼 (예: "f.key_id", "f2.key_id")
 * @param {Object}      scope
 * @param {string|null} scope.keyId
 * @param {string[]}    [scope.groupKeyIds]
 * @returns {string} 선행 공백 포함 AND 절 또는 ""
 */
export function keyScopeClause(params, column, { keyId, groupKeyIds }) {
  if (keyId == null) {
    return "";
  }
  const arr = (Array.isArray(groupKeyIds) && groupKeyIds.length > 0)
    ? groupKeyIds
    : [keyId];
  params.push(keyId, arr);
  const scalarIdx = params.length - 1;
  const arrIdx    = params.length;
  return ` AND (${column} IS NOT DISTINCT FROM $${scalarIdx} OR ${column} = ANY($${arrIdx}::text[]))`;
}

/**
 * 파일럿용 정확한 (key_id, workspace) 범위 조건을 생성한다.
 *
 * 이 경로에서는 그룹 키 확장과 NULL global 행을 허용하지 않는다.
 * strict pilot 호출은 두 축을 모두 제공해야 한다. 한 축만 주어진 경우
 * 호출자가 더 넓은 범위로 폴백하지 않도록 바인딩 없이 FALSE를 반환한다.
 *
 * @param {Array} params 바인딩 배열 (in-place push)
 * @param {string} alias 컬럼 alias (예: "f")
 * @param {{keyId?: string|null, workspace?: string|null}} scope
 * @returns {string} 선행 공백 포함 AND 절 또는 ""
 */
export function exactScopeClause(params, alias, { keyId = null, workspace = null } = {}) {
  const hasKey = keyId != null;
  const hasWorkspace = workspace != null;
  if (!hasKey && !hasWorkspace) return "";
  if (Array.isArray(keyId) || Array.isArray(workspace) || !hasKey || !hasWorkspace) {
    return " AND FALSE";
  }
  params.push(keyId);
  const keyIdx = params.length;
  params.push(workspace);
  const workspaceIdx = params.length;
  return ` AND ${alias}.key_id = $${keyIdx} AND ${alias}.workspace = $${workspaceIdx}`;
}
