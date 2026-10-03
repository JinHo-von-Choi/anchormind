/**
 * FragmentImporter - 가져오기 행 기록
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 가져오기 행 하나를 의미 쓰기 관문(WriteGate)에 통과시키고 FragmentWriter의 의미 메서드로
 * 기록한다. admin 가져오기와 CLI 가져오기가 함께 쓴다. 관문이 받아들이지 않은 행은 결과로
 * 돌려주고, 기록 중 DB 오류는 호출자에게 전파한다.
 *
 * 기록 대상 key_id는 호출자가 정하는 대상 키(profile.keyId)이며 파일 행의 key_id는 읽지 않는다.
 * is_anchor는 owner 프로필에서만 행의 값을 따른다. restore 프로필은 저장된 값을 되살리는
 * 가져오기이며 owner에서만 만들 수 있다.
 */

import crypto                                   from "node:crypto";
import { WriteInputError }                      from "./WriteGate.js";
import { SymbolicPolicyViolationError }         from "../../symbolic/errors.js";
import { computeContentHash }                   from "../../tools/embedding.js";
import { REJECT_REASONS }                       from "../transfer/ImportReport.js";
import { ImportOptionError }                    from "../transfer/importErrors.js";

export { ImportOptionError };

/** 진입점별 기본값. */
export const IMPORT_DEFAULTS = Object.freeze({
  admin: Object.freeze({ source: null,     agentId: "default" }),
  cli  : Object.freeze({ source: "import", agentId: "cli"     })
});

const TTL_TIERS         = Object.freeze(["short", "hot", "warm", "cold", "permanent"]);
const WORKSPACE_SOURCES = Object.freeze(["explicit", "key_default", "inferred", "unscoped"]);

/**
 * 가져오기 프로필을 만든다. 진입점 기본값에 대상 키와 권한을 더한다.
 *
 * @param {{source: string|null, agentId: string}} defaults - IMPORT_DEFAULTS 값
 * @param {Object}      [target]
 * @param {string|null} [target.keyId=null]  - 기록할 키. null은 마스터 범위
 * @param {boolean}     [target.owner=false] - 소유자 경로(관리 API, 서버 호스트의 CLI)인지
 * @param {boolean}     [target.restore=false] - 저장된 값을 되살리는 가져오기. owner에서만 가능
 * @returns {Readonly<{source: string|null, agentId: string, keyId: string|null, owner: boolean, restore: boolean}>}
 */
export function importProfile(defaults, { keyId = null, owner = false, restore = false } = {}) {
  if (restore && !owner) throw new ImportOptionError("restore import requires the owner path");
  return Object.freeze({ source: defaults.source, agentId: defaults.agentId, keyId, owner, restore });
}

/**
 * 시각 값을 ISO 문자열로 바꾼다. 해석할 수 없거나 내일 이후면 undefined다.
 *
 * @param {unknown} value
 * @returns {string|undefined}
 */
function validTimestamp(value) {
  if (typeof value !== "string" && !(value instanceof Date)) return undefined;
  const ms = new Date(value).getTime();
  if (Number.isNaN(ms) || ms > Date.now() + 86_400_000) return undefined;
  return new Date(ms).toISOString();
}

/** 문자열이면 그 값, 아니면 null. */
function textOrNull(value) {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * 가져오기 행을 FragmentWriter.insert가 받는 파편으로 만든다.
 *
 * @param {Object} row     - 관문 본문 단계를 거친 가져오기 행
 * @param {Object} profile - importProfile 결과
 * @returns {Object}
 */
export function buildImportFragment(row, profile) {
  const workspace       = textOrNull(row.workspace);
  const trustedSource   = profile.restore && WORKSPACE_SOURCES.includes(row.workspace_source);
  const keepTtl         = profile.restore && TTL_TIERS.includes(row.ttl_tier);

  return {
    id               : row.id || crypto.randomUUID(),
    content          : row.content,
    topic            : row.topic,
    type             : row.type || "fact",
    keywords         : Array.isArray(row.keywords) ? row.keywords : [],
    importance       : typeof row.importance === "number" ? row.importance : 0.5,
    source           : row.source || profile.source,
    agent_id         : row.agent_id || profile.agentId,
    key_id           : profile.keyId,
    is_anchor        : profile.owner && row.is_anchor === true,
    ttl_tier         : keepTtl ? row.ttl_tier : "warm",
    case_id          : row.case_id || null,
    idempotency_key  : row.idempotency_key || null,
    goal             : row.goal || null,
    outcome          : row.outcome || null,
    phase            : row.phase || null,
    resolution_status: row.resolution_status || null,
    assertion_status : row.assertion_status || null,
    context_summary  : textOrNull(row.context_summary),
    workspace,
    workspace_source : trustedSource ? row.workspace_source : (workspace ? "explicit" : "unscoped"),
    affect           : row.affect,
    created_at       : validTimestamp(row.created_at),
    valid_from       : validTimestamp(row.valid_from)
  };
}

/**
 * 파일 행에 있지만 이 프로필이 반영하지 않는 필드 이름.
 *
 * @param {Object} row
 * @param {Object} profile
 * @returns {Array<"key_id"|"is_anchor">}
 */
export function ignoredFields(row, profile) {
  const ignored = [];
  if (row.key_id != null && row.key_id !== profile.keyId) ignored.push("key_id");
  if (row.is_anchor === true && !profile.owner) ignored.push("is_anchor");
  return ignored;
}

/**
 * 관문이 쓰기를 받아들이지 않았다는 뜻의 오류인지 보고 사유 유형을 돌려준다.
 *
 * @param {unknown} err
 * @returns {string|null} REJECT_REASONS 값, 거부가 아니면 null
 */
function gateRejectionReason(err) {
  if (err instanceof WriteInputError) return REJECT_REASONS.INPUT_INVALID;
  if (err instanceof SymbolicPolicyViolationError) return REJECT_REASONS.POLICY_VIOLATION;
  return null;
}

/** PostgreSQL unique_violation. 같은 id가 이미 있는 행이다. */
export const UNIQUE_VIOLATION = "23505";

/**
 * 행 하나의 값 때문에 생긴 DB 오류인지 본다. SQLSTATE 22(데이터 예외)와 23(무결성 제약 위반)
 * 계열이 해당한다. 연결 오류와 그 밖의 서버 오류는 행 문제가 아니므로 해당하지 않는다.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isRowLevelDbError(err) {
  const code = typeof err?.code === "string" ? err.code : "";
  return /^[0-9A-Z]{5}$/.test(code) && (code.startsWith("22") || code.startsWith("23"));
}

/**
 * 가져오기 행 하나를 관문에 통과시킨다. DB에 쓰지 않으므로 트랜잭션 밖에서 부른다.
 *
 * @param {Object} row
 * @param {Object} deps
 * @param {string} deps.entry    - WRITE_ENTRIES.ADMIN_IMPORT 또는 CLI_IMPORT
 * @param {import("./WriteGate.js").WriteGate} deps.gate
 * @param {Object} deps.profile  - importProfile 결과
 * @returns {Promise<{status: "ready", draft: Object, warnings: string[], transformed: boolean}
 *   |{status: "rejected", reasonCode: string, reason: string}>}
 */
export async function checkImportRow(row, { entry, gate, profile }) {
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    return { status: "rejected", reasonCode: REJECT_REASONS.INVALID_ROW, reason: "row must be an object" };
  }
  try {
    const { draft, warnings } = await gate.check({
      entry,
      op    : "create",
      mode  : "production",
      fields: row,
      ctx   : { keyId: profile.keyId, agentId: row.agent_id || profile.agentId },
      build : (input) => buildImportFragment(input, profile)
    });
    const transformed = typeof row.content_hash === "string"
      && computeContentHash(draft.content) !== row.content_hash;
    return { status: "ready", draft, warnings, transformed };
  } catch (err) {
    const reasonCode = gateRejectionReason(err);
    if (reasonCode === null) throw err;
    return { status: "rejected", reasonCode, reason: err.message };
  }
}

/**
 * 관문을 통과한 행을 FragmentWriter 의미 메서드로 기록한다. 같은 본문이 이미 있으면 duplicate,
 * 같은 id가 이미 있으면 conflict, 그 밖에 행의 값 때문에 DB가 거부하면(CHECK 제약 등) rejected로
 * 돌려준다. 연결 오류처럼 행 문제가 아닌 오류는 전파한다.
 *
 * @param {{draft: Object, warnings: string[]}} prepared - checkImportRow의 ready 결과
 * @param {Object} deps
 * @param {{ insertDetailed: Function }} deps.writer
 * @param {Object} deps.profile
 * @param {import("pg").PoolClient} [deps.client] - 호출자가 연 트랜잭션 client
 * @returns {Promise<{status: "imported"|"duplicate"|"conflict"|"rejected", id?: string, reason?: string, code?: string, warnings: string[]}>}
 */
export async function writeImportRow({ draft, warnings }, { writer, profile, client }) {
  let result;
  try {
    result = await writer.insertDetailed(draft, { client, exactImportance: profile.restore });
  } catch (err) {
    if (err?.code === UNIQUE_VIOLATION) return { status: "conflict", warnings };
    if (!isRowLevelDbError(err)) throw err;
    return { status: "rejected", reason: `database rejected the row (${err.code})`, code: err.code, warnings };
  }
  if (result == null) throw new Error("Database pool unavailable");
  return { status: result.created ? "imported" : "duplicate", id: result.id, warnings };
}
