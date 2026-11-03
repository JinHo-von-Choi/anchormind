/**
 * 요청 workspace의 별칭 해석
 *
 * 작성자: 최진호
 * 작성일: 2026-11-04
 *
 * 도구 호출 인자의 workspace(일괄 저장은 항목마다)가 키의 별칭이면 정식 이름으로 바꾼다. 신뢰 맥락을 붙이기 전
 * (jsonrpc.handleToolsCall)에 한 번 부르므로, 이후의 허가 판정(allowed_workspaces), 그룹 공유 workspace 판정,
 * 저장과 읽기 범위가 모두 정식 이름을 쓴다. 별칭은 한 단계만 따른다(저장소가 사슬을 만들지 않는다).
 */

import { getWorkspaceAliases } from "./policy.js";

/**
 * @param {Map<string, string>} aliases
 * @param {unknown} workspace
 * @returns {unknown}
 */
function resolveOne(aliases, workspace) {
  if (typeof workspace !== "string") return workspace;
  return aliases.get(workspace) ?? workspace;
}

/**
 * 인자의 workspace를 정식 이름으로 바꾼다. 바꾼 이름 목록(원래 이름 → 정식 이름)을 돌려준다.
 *
 * @param {object} args 도구 호출 인자(제자리에서 바꾼다)
 * @param {string|null} keyId
 * @param {{ aliasesOf?: (keyId: string|null) => Promise<Map<string, string>> }} [deps]
 * @returns {Promise<Array<{ from: string, to: string }>>}
 */
export async function resolveWorkspaceAliases(args, keyId, { aliasesOf = getWorkspaceAliases } = {}) {
  if (!args || typeof args !== "object" || keyId == null) return [];
  const hasItems = Array.isArray(args.fragments) && args.fragments.some((f) => typeof f?.workspace === "string");
  if (typeof args.workspace !== "string" && !hasItems) return [];

  const aliases = await aliasesOf(keyId);
  if (aliases.size === 0) return [];

  const changed = [];
  const apply   = (holder) => {
    const next = resolveOne(aliases, holder.workspace);
    if (next !== holder.workspace) {
      changed.push({ from: holder.workspace, to: next });
      holder.workspace = next;
    }
  };
  if (typeof args.workspace === "string") apply(args);
  if (hasItems) for (const item of args.fragments) if (item && typeof item === "object") apply(item);
  return changed;
}

/**
 * tools/call 요청의 인자(params.arguments)에 resolveWorkspaceAliases를 적용한다. 키 id는 신뢰 세션에서 읽는다.
 *
 * @param {{ arguments?: unknown }} params
 * @param {{ keyId?: string|null }|null} sessionData
 * @returns {Promise<Array<{ from: string, to: string }>>}
 */
export function resolveRequestWorkspaceAliases(params, sessionData) {
  const args = params?.arguments;
  if (!args || typeof args !== "object" || Array.isArray(args)) return Promise.resolve([]);
  return resolveWorkspaceAliases(args, sessionData?.keyId ?? null);
}
