/**
 * workspace 없는 저장 호출 판정
 *
 * 작성자: 최진호
 * 작성일: 2026-10-13
 *
 * remember, batch_remember, reflect가 인자에도 키 기본값에도 workspace 없이 들어오면
 * 파편은 전역(NULL)으로 저장되어 모든 workspace의 recall 결과에 섞인다.
 * MEMENTO_MISSING_WORKSPACE(warn|reject|allow, 기본 warn)에 따라 경고하거나 거부한다.
 */

import { missingWorkspacePolicy } from "../config.js";
import { normalizeWorkspace }     from "../memory/write/DedupScope.js";

export const WORKSPACE_MISSING = "workspace_missing";

/**
 * 호출 인자가 workspace 없이 영구 저장되는지 판정한다.
 * scope=session 저장과 모든 항목에 workspace가 있는 batch_remember는 해당하지 않는다.
 *
 * @param {string} tool remember | batch_remember | reflect
 * @param {Object} args 도구 인자(_defaultWorkspace 포함)
 * @returns {boolean}
 */
export function isWorkspaceMissing(tool, args) {
  if (normalizeWorkspace(args.workspace) !== null)         return false;
  if (normalizeWorkspace(args._defaultWorkspace) !== null) return false;
  if (tool === "remember" && args.scope === "session")     return false;
  if (tool === "batch_remember") {
    const items = Array.isArray(args.fragments) ? args.fragments : [];
    return items.some(item => normalizeWorkspace(item?.workspace) === null);
  }
  return true;
}

/**
 * 정책에 따라 workspace 누락을 판정한다. reject 정책이면 -32602 오류를 던진다.
 *
 * @param {string} tool
 * @param {Object} args
 * @returns {{code: string, message: string}|null} warn 정책에서 응답에 실을 경고
 */
export function checkMissingWorkspace(tool, args) {
  const policy = missingWorkspacePolicy();
  if (policy === "allow" || !isWorkspaceMissing(tool, args)) return null;

  const message = "workspace is not set and the API key has no default_workspace; " +
    "fragments without a workspace are stored as global and appear in recall for every workspace";
  if (policy === "reject") {
    const err = new Error(`Invalid arguments for ${tool}: ${message}`);
    err.code  = -32602;
    throw err;
  }
  return { code: WORKSPACE_MISSING, message };
}

/**
 * 응답의 _meta.warnings에 경고를 더한다. 경고가 없거나 응답이 객체가 아니면 그대로 돌려준다.
 *
 * @param {Object} response
 * @param {{code: string, message: string}|null} warning
 * @returns {Object}
 */
export function withWorkspaceWarning(response, warning) {
  if (!warning || !response || typeof response !== "object") return response;
  return {
    ...response,
    _meta: {
      ...(response._meta ?? {}),
      warnings: [...(response._meta?.warnings ?? []), warning]
    }
  };
}
