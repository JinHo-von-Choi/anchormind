/**
 * SearchLayerScope - 검색 계층 호출에 넘기는 공통 범위 옵션
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * FragmentSearch가 시맨틱, 형태소, 보조 역질의, 그래프 이웃 계층을 부를 때 같은 모양으로 넘기는
 * workspace, agent, 앵커 필터와 검토 대기 가시성의 보는 주체(viewerKeyId)를 한곳에서 만든다.
 */

/**
 * 정규화된 검색 질의에서 계층 공통 범위 옵션을 만든다.
 *
 * @param {Object} query - FragmentSearch._buildSearchQuery 결과 또는 그 변형
 * @returns {{workspace: string|null, allWorkspaces: boolean, _isMaster?: true, includePeerAgents: boolean,
 *   isAnchor?: boolean, viewerKeyId: string|null|undefined}}
 */
export function layerScope(query) {
  return {
    workspace        : query.workspace ?? null,
    allWorkspaces    : query.allWorkspaces === true,
    ...(query._isMaster === true ? { _isMaster: true } : {}),
    includePeerAgents: query.includePeerAgents === true,
    ...(query.isAnchor !== undefined ? { isAnchor: query.isAnchor } : {}),
    viewerKeyId      : query.viewerKeyId
  };
}
