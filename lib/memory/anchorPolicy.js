/**
 * 앵커 권한 판정과 주체 표지
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 쓰기 관문의 anchor 단계와 context 주입 줄이 쓰는 순수 함수다. DB와 환경 변수를 읽지 않는다.
 *   anchorChange          쓰기 상태가 앵커를 새로 지정하는지(set), 내리는지(clear)
 *   decideAnchor          주체, 권한 목록, 살아 있는 앵커 수, 상한으로 허용 여부와 사유를 정한다
 *   anchorPrincipalLabel  키 이름 대신 키 id 해시 앞 4자로 만든 비식별 주체 표지
 */

import { createHash }          from "node:crypto";
import { hasAnchorPermission } from "../rbac.js";

/** 판정 사유 */
export const ANCHOR_REASONS = Object.freeze({
  MASTER       : "master",
  PERMITTED    : "permitted",
  PERMISSION   : "permission",
  LIMIT        : "limit",
  LOOKUP_FAILED: "lookup_failed"
});

/** 허용하지 않은 사유별 위반 규칙 이름 */
export const ANCHOR_RULES = Object.freeze({
  [ANCHOR_REASONS.PERMISSION]   : "anchorPermissionRequired",
  [ANCHOR_REASONS.LIMIT]        : "anchorLimitExceeded",
  [ANCHOR_REASONS.LOOKUP_FAILED]: "anchorLookupFailed"
});

/** 주체 표지에 쓰는 해시 앞자리 수 */
const LABEL_HASH_LENGTH = 4;

/**
 * 쓰기 상태의 앵커 변경 종류. 생성은 후보가 앵커이면 set이다. 갱신은 is_anchor를 바꾸는 경우에만
 * 앵커가 아니던 행을 앵커로 바꾸면 set, 앵커 행의 표시를 내리면 clear다.
 *
 * @param {{op: string, fields: Object, base?: Object|null, draft?: Object|null}} state
 * @returns {"set"|"clear"|null}
 */
export function anchorChange(state) {
  if (state.op === "create") return state.draft?.is_anchor === true ? "set" : null;
  if (!Object.hasOwn(state.fields ?? {}, "is_anchor")) return null;

  const next = state.fields.is_anchor === true;
  const prev = state.base?.is_anchor === true;
  if (next && !prev) return "set";
  if (!next && prev) return "clear";
  return null;
}

/**
 * 앵커 지정 요청을 판정한다. master는 권한과 상한 없이 허용한다. 키는 조회에 성공하고 anchor 권한이
 * 있으며 살아 있는 앵커 수가 상한보다 작을 때만 허용한다.
 *
 * @param {Object}   input
 * @param {boolean}  [input.isMaster]
 * @param {boolean}  [input.lookupFailed]
 * @param {string[]} [input.permissions]
 * @param {number}   [input.anchorCount]
 * @param {number}   [input.limit]
 * @returns {{granted: boolean, reason: string}}
 */
export function decideAnchor({ isMaster = false, lookupFailed = false, permissions = [], anchorCount = 0, limit = Infinity } = {}) {
  if (isMaster)                          return { granted: true,  reason: ANCHOR_REASONS.MASTER };
  if (lookupFailed)                      return { granted: false, reason: ANCHOR_REASONS.LOOKUP_FAILED };
  if (!hasAnchorPermission(permissions)) return { granted: false, reason: ANCHOR_REASONS.PERMISSION };
  if (anchorCount >= limit)              return { granted: false, reason: ANCHOR_REASONS.LIMIT };
  return { granted: true, reason: ANCHOR_REASONS.PERMITTED };
}

/**
 * 앵커 주입 줄에 붙일 비식별 주체 표지. 키 앵커는 `k:` 뒤에 키 id sha256 앞 4자, master 앵커는 `master`다.
 *
 * @param {string|null|undefined} keyId
 * @returns {string}
 */
export function anchorPrincipalLabel(keyId) {
  if (keyId == null) return "master";
  const digest = createHash("sha256").update(String(keyId)).digest("hex");
  return `k:${digest.slice(0, LABEL_HASH_LENGTH)}`;
}
