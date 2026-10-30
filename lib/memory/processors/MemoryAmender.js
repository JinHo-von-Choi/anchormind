/**
 * MemoryAmender - 기존 파편의 내용·메타데이터 갱신(amend)
 *
 * 작성자: 최진호
 * 작성일: 2026-10-31
 *
 * MemoryRememberer.amend가 위임한다. host는 store, index, caseEventStore, _writeGate()를 가진
 * MemoryRememberer다. 필드를 복사하지 않고 host를 받으므로 host의 의존성을 바꾸면 그대로 따른다.
 */

import { logWarn } from "../../logger.js";
import { extractRequestCtx } from "../keyId.js";
import { validateContentInput } from "../contentGuard.js";
import { WRITE_ENTRIES } from "../write/WriteGate.js";
import { provenanceContext } from "../provenance.js";
import { amendWorldTime } from "../write/EventTimeExtractor.js";

/** amend가 실제로 반영하는 파라미터. 이 목록 밖의 키는 조용히 무시하지 않고 호출자에게 알린다. */
const AMENDABLE_PARAMS = new Set([
  "id", "content", "topic", "keywords", "type", "importance", "isAnchor",
  "supersedes", "assertionStatus", "resolutionStatus", "outcome", "phase",
  "agentId", "dryRun", "mentionTime", "eventTime", "eventTimeEnd"
]);

/** amend 파라미터 이름과 파편 열 이름의 대응. keywords는 배열일 때만 반영한다. */
const AMEND_COLUMNS = [
  ["content", "content"], ["topic", "topic"], ["type", "type"], ["importance", "importance"],
  ["isAnchor", "is_anchor"], ["assertionStatus", "assertion_status"],
  ["resolutionStatus", "resolution_status"], ["outcome", "outcome"], ["phase", "phase"]
];

/**
 * amend 파라미터에서 바뀐 열만 뽑는다.
 *
 * @param {Object} params
 * @returns {Object} 열 이름을 키로 한 변경
 */
export function amendChanges(params) {
  const changes = {};
  for (const [param, column] of AMEND_COLUMNS) {
    if (params[param] !== undefined) changes[column] = params[param];
  }
  if (Array.isArray(params.keywords)) changes.keywords = params.keywords;
  return { ...changes, ...amendWorldTime(params).changes };
}

/**
 * amend dryRun 응답. 관문을 거친 예상 파편 상태를 돌려준다.
 *
 * @param {{draft: Object, warnings: string[]}} gated
 * @returns {Object}
 */
function amendDryRunResult({ draft, warnings }) {
  const simulated = {
    would_be_fragment: {
      id              : draft.id,
      type            : draft.type,
      content         : draft.content,
      topic           : draft.topic,
      keywords        : draft.keywords,
      importance      : draft.importance,
      is_anchor       : draft.is_anchor,
      assertion_status: draft.assertion_status
    }
  };
  if (warnings.length > 0) simulated.validation_warnings = warnings;
  return { dryRun: true, simulated };
}

/**
 * amend - 기존 파편의 content/metadata를 갱신
 * ID와 linked_to(링크)를 보존하면서 내용만 교체한다.
 *
 * @param {Object} params
 *   - id         {string} 갱신 대상 파편 ID (필수)
 *   - content    {string} 새 내용 (선택)
 *   - topic      {string} 새 주제 (선택)
 *   - keywords   {string[]} 새 키워드 (선택)
 *   - type       {string} 새 유형 (선택)
 *   - importance {number} 새 중요도 (선택)
 *   - agentId    {string} 에이전트 ID (선택)
 * @returns {Object} { updated, fragment }
 */
export async function amendFragment(host, params) {
  if (!params.id) {
    return { updated: false, error: "id is required" };
  }
  validateContentInput(params.content);

  /** 지원하지 않는 필드만 전달된 호출을 성공으로 보고하지 않는다.
   *  스키마 검증을 하지 않는 클라이언트에서도 조용한 무시가 발생하지 않게 서버에서 판정한다. */
  const unsupportedFields = Object.keys(params)
    .filter(k => !AMENDABLE_PARAMS.has(k) && !k.startsWith("_"));
  const suppliedFields = Object.keys(params)
    .filter(k => k !== "id" && k !== "dryRun" && k !== "agentId" && AMENDABLE_PARAMS.has(k));

  if (suppliedFields.length === 0 && unsupportedFields.length > 0) {
    return {
      updated: false,
      error  : "No amendable fields supplied",
      unsupportedFields
    };
  }

  const { agentId, keyId, groupKeyIds } = extractRequestCtx(params, { groupKeyIdsFallback: 'amend' });
  const existing    = await host.store.getById(params.id, agentId, keyId, groupKeyIds, { withReview: true });
  if (!existing) return amendMissing(host, params, agentId, keyId, groupKeyIds);
  /** 조회는 같은 그룹 키의 파편까지 하지만 수정은 쓴 키만 한다(FragmentWriter.update). */
  if (keyId && existing.key_id !== keyId) {
    return { updated: false, code: "not_owner", error: "Fragment is owned by another API key; only the key that stored it can amend it" };
  }

  /** 바뀐 열만 의미 쓰기 관문에 통과시킨다. M5 dryRun은 관문을 거친 예상 상태만 돌려준다. */
  const dryRun = params.dryRun === true;
  const gated  = await host._writeGate().check({
    entry : WRITE_ENTRIES.AMEND,
    op    : "update",
    mode  : dryRun ? "dryRun" : "production",
    fields: amendChanges(params),
    base  : existing,
    ctx   : { keyId, agentId, provenance: provenanceContext(params), isMaster: params._isMaster === true }
  });
  if (dryRun) return amendDryRunResult(gated);

  const result = await host.store.update(params.id, gated.fields, agentId, keyId, existing);

  if (!result) {
    return { updated: false, error: "Update failed" };
  }

  if (result.merged) {
    return { updated: false, merged: true, existingId: result.existingId };
  }

  if (params.supersedes) {
    /**
     * in-place update 구조에서 superseded_by 자기참조 링크는 무의미.
     * archive(fragment_versions INSERT)로 이력이 보존되며,
     * verified_at은 update() 내부에서 NOW()로 갱신된다.
     */
  }

  /** Redis 인덱스 갱신: 기존 제거 후 재등록 */
  await host.index.deindex(existing.id, existing.keywords, existing.topic, existing.type, existing.key_id ?? null, { content: existing.content });
  await host.index.index(result, null, existing.key_id ?? null);

  recordAmendCaseEvents(host, params, existing);

  const response     = { updated: true, fragment: result };
  const timeWarnings = amendWorldTime(params).warnings.map(w => w.rule);
  const warnings     = [...gated.warnings, ...timeWarnings];
  if (warnings.length > 0) response.validation_warnings = warnings;
  return response;
}

/**
 * amend 대상이 보이지 않을 때의 응답. 만료 파편과 미존재·권한 부족을 구분한다.
 * 만료 파편은 이력이므로 수정 대상이 아니다.
 *
 * @returns {Promise<Object>}
 */
async function amendMissing(host, params, agentId, keyId, groupKeyIds) {
  const expired = await host.store.getById(
    params.id, agentId, keyId, groupKeyIds, { includeExpired: true }
  ).catch((err) => {
    logWarn(`[MemoryAmender] expired lookup failed for ${params.id}: ${err.message}`);
    return null;
  });

  if (expired) {
    return {
      updated: false,
      error  : "Fragment is expired (valid_to set) and cannot be amended",
      validTo: expired.valid_to ?? null
    };
  }
  return { updated: false, error: "Fragment not found or no permission" };
}

/** assertion_status 전환 중 사례 이벤트로 남기는 것과 그 유형 */
const ASSERTION_EVENT_TYPES = Object.freeze({ verified: "verification_passed", rejected: "verification_failed" });

/**
 * 원본 파편에서 사례 이벤트를 만든다. key_id는 요청 키가 아니라 신뢰된 원본 파편 소유 키로 고정한다.
 * master/group-peer amend도 원본 snapshot을 실제 소유 키로 조회하기 위해서다.
 *
 * @param {Object} existing
 * @param {string} eventType
 * @param {string} summary
 * @returns {Object}
 */
function amendCaseEvent(existing, eventType, summary) {
  return {
    case_id           : existing.case_id,
    session_id        : existing.session_id ?? null,
    event_type        : eventType,
    summary           : summary.slice(0, 200),
    source_fragment_id: existing.id,
    entity_keys       : existing.keywords || [],
    key_id            : existing.key_id ?? null,
    evidence          : [{ fragment_id: existing.id, kind: "produced_by" }]
  };
}

/**
 * amend가 바꾼 상태를 case_events에 기록한다 (fire-and-forget).
 * assertion_status 전환(verified, rejected)과 resolved 전환만 남긴다.
 *
 * @param {Object} params
 * @param {Object} existing - 갱신 전 파편
 */
function recordAmendCaseEvents(host, params, existing) {
  if (!existing.case_id || !host.caseEventStore) return;

  const assertionEvent = existing.assertion_status !== params.assertionStatus
    ? ASSERTION_EVENT_TYPES[params.assertionStatus]
    : undefined;
  if (assertionEvent) {
    host.caseEventStore.append(amendCaseEvent(existing, assertionEvent, existing.content || ""))
      .catch(err => logWarn(`[MemoryRememberer] amend event recording failed: ${err.message}`));
  }

  if (params.resolutionStatus === "resolved" && existing.resolution_status !== "resolved") {
    host.caseEventStore.append(amendCaseEvent(existing, "case_closed", params.outcome || existing.content || ""))
      .catch(err => logWarn(`[MemoryRememberer] case close event recording failed: ${err.message}`));
  }
}
