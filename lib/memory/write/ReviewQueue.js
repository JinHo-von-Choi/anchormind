/**
 * ReviewQueue - 비차단 검토 대기열의 동기 판정
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 쓰기 관문이 판정 단계와 출처 단계 뒤에 부르는 검토 단계다. 응답 전에 결정할 수 있는 규칙만 쓴다.
 *
 *   instruction_override  본문 필드에 지시 덮어쓰기 문구(reviewRules.js)
 *   low_trust_directive   신뢰 등급 1 이하의 앵커, preference, procedure(생성만. 갱신은 등급을 바꾸지 않는다)
 *   anchor_unauthorized   앵커 권한 단계가 남긴 무권한 앵커 경고(ANCHOR_PERMISSION_RULE)
 *   mode_all              키의 검토 방식이 all이고 다른 사유가 없을 때
 *
 * 표지가 달린 파편은 거부하지 않고 fragments에 review_state='pending', review_reason=사유 목록으로 저장된다.
 * 앵커 지정 요청(isAnchor)은 검토 대기 동안 적용하지 않고 review_reason에 anchor_requested로 남기며,
 * 승인할 때 적용한다. 검토 대기 파편은 앵커가 아니므로 같은 본문 충돌 갱신이 기존 행을 앵커로 올리지 않는다.
 * 쓴 키의 recall에는 보이고, 다른 키(키 그룹 포함), ANCHOR와 CORE 주입, 앵커 승격에서는 빠진다
 * (lib/memory/read/ReviewVisibility.js). 사유는 review.<사유> 이름의 낮은 등급 경고로도 남아 응답의
 * validation_warnings에 실린다. 이 경고는 hard gate 거부 대상이 아니다.
 *
 * 비밀과 개인정보는 검토 대상이 아니다. 이 단계는 민감 정보 단계(마스킹 또는 거부) 뒤에 실행되므로
 * 검토 대기 파편에는 가려진 본문만 남고, 사유에는 규칙 이름만 남는다.
 *
 * DB, 설정, 환경 변수에 닿지 않는다. 스위치는 deps.reviewQueueEnabled로 받는다.
 */

import { REVIEW_STATES, DEFAULT_REVIEW_MODE, reviewModeOrNull } from "../reviewState.js";
import { matchInstructionOverride }                              from "./reviewRules.js";
import { effectiveTrustTier, TRUST_TIER }                        from "../provenance.js";

/** 검토 사유 */
export const REVIEW_REASONS = Object.freeze({
  INSTRUCTION_OVERRIDE: "instruction_override",
  LOW_TRUST_DIRECTIVE : "low_trust_directive",
  ANCHOR_UNAUTHORIZED : "anchor_unauthorized",
  MODE_ALL            : "mode_all"
});

/** review_reason에 함께 남기는 요청 표지. 승인할 때 앵커로 지정한다. */
export const ANCHOR_REQUEST_MARK = "anchor_requested";

/** 검토 사유를 경고 이름으로 바꿀 때의 접두어 */
export const REVIEW_RULE_PREFIX = "review.";

/** 검토 단계를 적용하는 쓰기 진입점. 클라이언트가 본문을 정하는 진입점만 대상이다. */
export const REVIEW_ENTRIES = Object.freeze(["remember", "batch_remember", "reflect", "amend"]);

/**
 * 앵커 권한 단계가 무권한 앵커 요청을 일반 파편으로 낮춰 저장할 때(경고 기간) 남기는 위반 규칙 이름.
 * 검토 단계는 이 이름의 위반이 있으면 anchor_unauthorized 사유를 단다.
 */
export const ANCHOR_PERMISSION_RULE = "anchorPermissionRequired";

/** 등급 1 이하일 때 검토하는 지시성 유형 */
export const DIRECTIVE_TYPES = Object.freeze(["preference", "procedure"]);

/** 지시 덮어쓰기 문구를 찾는 후보 열(생성 후보와 갱신 열 모두 열 이름) */
export const REVIEW_TEXT_COLUMNS = Object.freeze(["content", "context_summary", "goal", "outcome", "topic"]);

/** 검토 열 이름. INSERT 열 순서와 같다. */
export const REVIEW_COLUMNS = Object.freeze(["review_state", "review_reason"]);

const REASON_ORDER = Object.freeze([
  REVIEW_REASONS.INSTRUCTION_OVERRIDE,
  REVIEW_REASONS.LOW_TRUST_DIRECTIVE,
  REVIEW_REASONS.ANCHOR_UNAUTHORIZED,
  REVIEW_REASONS.MODE_ALL
]);

/** review_reason 저장 순서(사유 다음에 요청 표지) */
const STORED_ORDER = Object.freeze([...REASON_ORDER, ANCHOR_REQUEST_MARK]);

/**
 * 검토할 본문 열. 생성은 후보의 모든 본문 열, 갱신은 이번에 바뀐 본문 열만 본다.
 *
 * @param {"create"|"update"} op
 * @param {Object} draft
 * @param {Object} fields
 * @returns {string[]}
 */
function textsToScan(op, draft, fields) {
  const columns = op === "update"
    ? REVIEW_TEXT_COLUMNS.filter((column) => Object.hasOwn(fields ?? {}, column))
    : REVIEW_TEXT_COLUMNS;
  return columns.map((column) => draft?.[column]).filter((value) => typeof value === "string" && value !== "");
}

/**
 * 지시 덮어쓰기 규칙 id 목록(중복 없음).
 *
 * @param {string[]} texts
 * @returns {string[]}
 */
function overrideRuleIds(texts) {
  return [...new Set(texts.flatMap(matchInstructionOverride))];
}

/**
 * 생성 후보가 등급 1 이하의 지시성 파편인지 본다. 출처 값이 없는 후보(출처 스위치 off)는 등급 2로 본다.
 *
 * @param {Object} draft
 * @returns {boolean}
 */
function isLowTrustDirective(draft) {
  if (effectiveTrustTier(draft?.trust_tier) > TRUST_TIER.LOW) return false;
  return draft?.is_anchor === true || DIRECTIVE_TYPES.includes(draft?.type);
}

/**
 * 규칙에 걸린 검토 사유를 정해진 순서로 돌려준다(flagged 방식의 판정).
 *
 * @param {{op: "create"|"update", draft: Object, fields?: Object, violations?: Array<Object>}} input
 * @returns {string[]}
 */
export function reviewReasons({ op, draft, fields = {}, violations = [] }) {
  const found = new Set();
  if (overrideRuleIds(textsToScan(op, draft, fields)).length > 0) found.add(REVIEW_REASONS.INSTRUCTION_OVERRIDE);
  if (op === "create" && isLowTrustDirective(draft))              found.add(REVIEW_REASONS.LOW_TRUST_DIRECTIVE);
  if (violations.some((v) => v?.rule === ANCHOR_PERMISSION_RULE))  found.add(REVIEW_REASONS.ANCHOR_UNAUTHORIZED);
  return REASON_ORDER.filter((reason) => found.has(reason));
}

/**
 * 검토 방식으로 표지를 정한다. off는 표지 없음, flagged는 사유가 있을 때만, all은 언제나 표지를 단다.
 * 모르는 방식은 기본 방식으로 본다.
 *
 * @param {unknown}  mode
 * @param {string[]} reasons
 * @returns {string[]} 저장할 사유. 빈 배열이면 표지를 달지 않는다
 */
export function decideReview(mode, reasons) {
  const effective = reviewModeOrNull(mode) ?? DEFAULT_REVIEW_MODE;
  if (effective === "off") return [];
  if (effective === "all" && reasons.length === 0) return [REVIEW_REASONS.MODE_ALL];
  return [...reasons];
}

/**
 * 검토 사유를 낮은 등급 경고로 바꾼다. 세부에는 규칙 id만 싣는다.
 *
 * @param {string[]} reasons
 * @param {string[]} ruleIds - 지시 덮어쓰기 규칙 id
 * @returns {Array<Object>}
 */
function reviewNotices(reasons, ruleIds) {
  return reasons.map((reason) => ({
    rule       : `${REVIEW_RULE_PREFIX}${reason}`,
    severity   : "low",
    detail     : reason === REVIEW_REASONS.INSTRUCTION_OVERRIDE ? `rules: ${ruleIds.join(", ")}` : "review pending",
    ruleVersion: "v1"
  }));
}

/**
 * 검토 대기열 경고인지 본다. hard gate 거부 대상에서 뺀다.
 *
 * @param {Object} v
 * @returns {boolean}
 */
export function isReviewNotice(v) {
  return typeof v?.rule === "string" && v.rule.startsWith(REVIEW_RULE_PREFIX);
}

/**
 * review_reason 문자열을 사유와 표지 목록으로 나눈다.
 *
 * @param {unknown} stored
 * @returns {string[]}
 */
export function parseReviewReason(stored) {
  return typeof stored === "string" ? stored.split(",").filter((part) => STORED_ORDER.includes(part)) : [];
}

/**
 * 저장할 review_reason. 갱신 대상이 이미 검토 대기이면 앞선 사유와 표지를 이어 붙인다.
 *
 * @param {Object|null} base
 * @param {string[]}    entries - 이번 사유와 표지
 * @returns {string}
 */
function mergedReason(base, entries) {
  const prior = base?.review_state === REVIEW_STATES.PENDING ? parseReviewReason(base.review_reason) : [];
  return STORED_ORDER.filter((entry) => prior.includes(entry) || entries.includes(entry)).join(",");
}

/**
 * 이번 쓰기가 앵커 지정을 요청했는지 본다. 생성은 후보의 is_anchor, 갱신은 바뀐 열의 is_anchor다.
 *
 * @param {Object} state
 * @returns {boolean}
 */
function requestsAnchor(state) {
  return state.op === "create" ? state.draft?.is_anchor === true : state.fields?.is_anchor === true;
}

/**
 * 검토 대기 동안 앵커 요청을 보류한 쓰기 값. 생성은 후보의 is_anchor를 false로, 갱신은 is_anchor 변경을 뺀다.
 *
 * @param {Object}  state
 * @param {Object}  columns - review_state, review_reason
 * @returns {Object}
 */
function withHeldAnchor(state, columns) {
  if (state.op === "create") {
    const held = requestsAnchor(state) ? { is_anchor: false } : {};
    return { ...state, draft: Object.assign(state.draft, columns, held) };
  }
  if (!requestsAnchor(state)) {
    return { ...state, fields: { ...state.fields, ...columns }, draft: { ...state.draft, ...columns } };
  }
  const { is_anchor: _requested, ...rest } = state.fields;
  return { ...state, fields: { ...rest, ...columns }, draft: { ...state.draft, ...columns, is_anchor: state.base?.is_anchor === true } };
}

/**
 * 검토 단계. 검토 진입점의 쓰기에서 사유를 판정하고, 키의 검토 방식(ctx.provenance.reviewMode, 없으면
 * flagged)이 표지를 정하면 생성 후보 또는 갱신 열에 review_state='pending'과 review_reason을 싣고
 * 사유를 경고로 덧붙인다. 앵커 지정 요청은 보류하고 anchor_requested 표지로 남긴다.
 * 스위치가 off이면 새 표지를 달지 않지만, 이미 검토 대기인 파편의 앵커 지정 갱신은 계속 보류한다.
 *
 * @param {Object} state - 관문 상태(entry, op, fields, base, draft, ctx, violations)
 * @param {{reviewQueueEnabled: () => boolean}} deps
 * @returns {Object}
 */
export function reviewStep(state, deps) {
  if (!REVIEW_ENTRIES.includes(state.entry)) return state;

  const reasons = deps.reviewQueueEnabled()
    ? decideReview(state.ctx?.provenance?.reviewMode,
      reviewReasons({ op: state.op, draft: state.draft, fields: state.fields, violations: state.violations }))
    : [];
  if (reasons.length === 0) return holdAnchorWhilePending(state);

  const entries  = requestsAnchor(state) ? [...reasons, ANCHOR_REQUEST_MARK] : reasons;
  const columns  = { review_state: REVIEW_STATES.PENDING, review_reason: mergedReason(state.base, entries) };
  const ruleIds  = overrideRuleIds(textsToScan(state.op, state.draft, state.fields));
  const notices  = reviewNotices(reasons, ruleIds);
  return withHeldAnchor({ ...state, review: { reasons }, violations: [...state.violations, ...notices] }, columns);
}

/**
 * 검토 대기 파편의 앵커 지정 갱신은 새 사유가 없어도(스위치 off 포함) 보류하고 anchor_requested 표지로 남긴다.
 *
 * @param {Object} state
 * @returns {Object}
 */
function holdAnchorWhilePending(state) {
  if (state.op !== "update" || state.base?.review_state !== REVIEW_STATES.PENDING || !requestsAnchor(state)) return state;
  return withHeldAnchor(state, {
    review_state : REVIEW_STATES.PENDING,
    review_reason: mergedReason(state.base, [ANCHOR_REQUEST_MARK])
  });
}

/**
 * 파편이 검토 열 값을 가졌는지 본다.
 *
 * @param {Object|null} fragment
 * @returns {boolean}
 */
export function hasReviewState(fragment) {
  return fragment != null && typeof fragment.review_state === "string";
}

/**
 * INSERT 문에 덧붙일 검토 열 조각. 검토 값이 없고 force가 아니면 빈 조각이라 문장이 바뀌지 않는다.
 *
 * @param {Object} fragment
 * @param {number} startIndex - 첫 자리표시자 번호
 * @param {{force?: boolean}} [options] - 같은 문장의 다른 행이 검토 값을 가질 때 NULL로 채운다
 * @returns {{columns: string, placeholders: string, values: Array}}
 */
export function reviewInsertParts(fragment, startIndex, { force = false } = {}) {
  if (!force && !hasReviewState(fragment)) return { columns: "", placeholders: "", values: [] };
  return {
    columns     : `, ${REVIEW_COLUMNS.join(", ")}`,
    placeholders: `, $${startIndex}, $${startIndex + 1}`,
    values      : [fragment?.review_state ?? null, fragment?.review_reason ?? null]
  };
}

/**
 * UPDATE SET 절에 검토 열을 덧붙인다. 갱신 열에 review_state가 없으면 아무것도 하지 않는다.
 * 자리표시자 번호는 params 길이로 정한다.
 *
 * @param {string[]} setClauses - in-place
 * @param {Array}    params     - in-place
 * @param {Object}   updates
 */
export function appendReviewAssignments(setClauses, params, updates) {
  if (!hasReviewState(updates)) return;
  params.push(updates.review_state, updates.review_reason ?? null);
  setClauses.push(`review_state = $${params.length - 1}`, `review_reason = $${params.length}`);
}
