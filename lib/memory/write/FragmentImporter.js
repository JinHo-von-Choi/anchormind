/**
 * FragmentImporter - 가져오기 행 기록
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 가져오기 행 하나를 의미 쓰기 관문(WriteGate)에 통과시키고 FragmentWriter의 의미 메서드로
 * 기록한다. admin 가져오기와 CLI 가져오기가 함께 쓴다. 관문이 받아들이지 않은 행은 결과로
 * 돌려주고, 기록 중 DB 오류는 호출자에게 전파한다.
 */

import crypto                                   from "node:crypto";
import { WriteInputError }                      from "./WriteGate.js";
import { SymbolicPolicyViolationError }         from "../../symbolic/errors.js";

/**
 * 진입점별 기본값. admin은 행의 key_id를 대상 키로 쓰고, CLI는 마스터(key_id NULL)로 기록한다.
 */
export const IMPORT_DEFAULTS = Object.freeze({
  admin: Object.freeze({ source: null,     agentId: "default", keyFromRow: true }),
  cli  : Object.freeze({ source: "import", agentId: "cli",     keyFromRow: false })
});

/**
 * 가져오기 행을 FragmentWriter.insert가 받는 파편으로 만든다.
 *
 * @param {Object} row      - 관문 본문 단계를 거친 가져오기 행
 * @param {Object} defaults - IMPORT_DEFAULTS 값
 * @returns {Object}
 */
export function buildImportFragment(row, defaults) {
  return {
    id               : row.id || crypto.randomUUID(),
    content          : row.content,
    topic            : row.topic,
    type             : row.type || "fact",
    keywords         : Array.isArray(row.keywords) ? row.keywords : [],
    importance       : typeof row.importance === "number" ? row.importance : 0.5,
    source           : row.source || defaults.source,
    agent_id         : row.agent_id || defaults.agentId,
    key_id           : defaults.keyFromRow ? (row.key_id ?? null) : null,
    is_anchor        : row.is_anchor === true,
    ttl_tier         : "warm",
    case_id          : row.case_id || null,
    idempotency_key  : row.idempotency_key || null,
    goal             : row.goal || null,
    outcome          : row.outcome || null,
    phase            : row.phase || null,
    resolution_status: row.resolution_status || null,
    assertion_status : row.assertion_status || null
  };
}

/**
 * 관문이 쓰기를 받아들이지 않았다는 뜻의 오류인지 본다.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
function isGateRejection(err) {
  return err instanceof WriteInputError || err instanceof SymbolicPolicyViolationError;
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
 * @param {Object}  deps.defaults - IMPORT_DEFAULTS 값
 * @param {boolean} [deps.dryRun]
 * @returns {Promise<{status: "ready", draft: Object, warnings: string[]}|{status: "rejected", reason: string}>}
 */
export async function checkImportRow(row, { entry, gate, defaults, dryRun = false }) {
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    return { status: "rejected", reason: "row must be an object" };
  }
  try {
    const { draft, warnings } = await gate.check({
      entry,
      op    : "create",
      mode  : dryRun ? "dryRun" : "production",
      fields: row,
      ctx   : { keyId: defaults.keyFromRow ? (row.key_id ?? null) : null, agentId: row.agent_id || defaults.agentId },
      build : (input) => buildImportFragment(input, defaults)
    });
    return { status: "ready", draft, warnings };
  } catch (err) {
    if (!isGateRejection(err)) throw err;
    return { status: "rejected", reason: err.message };
  }
}

/**
 * 관문을 통과한 행을 FragmentWriter 의미 메서드로 기록한다. 같은 본문이 이미 있으면 duplicate,
 * 같은 id가 이미 있으면 conflict, 그 밖에 행의 값 때문에 DB가 거부하면(CHECK 제약 등) rejected로
 * 돌려준다. 연결 오류처럼 행 문제가 아닌 오류는 전파한다.
 *
 * @param {{draft: Object, warnings: string[]}} prepared - checkImportRow의 ready 결과
 * @param {Object} deps
 * @param {{ insert: Function }} deps.writer
 * @param {import("pg").PoolClient} [deps.client] - 호출자가 연 트랜잭션 client
 * @returns {Promise<{status: "imported"|"duplicate"|"conflict"|"rejected", id?: string, reason?: string, code?: string, warnings: string[]}>}
 */
export async function writeImportRow({ draft, warnings }, { writer, client }) {
  let id;
  try {
    id = await writer.insert(draft, { client });
  } catch (err) {
    if (err?.code === UNIQUE_VIOLATION) return { status: "conflict", warnings };
    if (!isRowLevelDbError(err)) throw err;
    return { status: "rejected", reason: `database rejected the row (${err.code})`, code: err.code, warnings };
  }
  if (id == null) throw new Error("Database pool unavailable");
  return { status: id === draft.id ? "imported" : "duplicate", id, warnings };
}

/**
 * 가져오기 행 하나를 관문에 통과시키고 기록한다(admin 가져오기).
 *
 * @returns {Promise<{status: "imported"|"duplicate"|"conflict"|"rejected", id?: string, reason?: string, warnings?: string[]}>}
 */
export async function importFragment(row, { entry, gate, writer, client, defaults }) {
  const prepared = await checkImportRow(row, { entry, gate, defaults });
  if (prepared.status === "rejected") return prepared;
  return writeImportRow(prepared, { writer, client });
}
