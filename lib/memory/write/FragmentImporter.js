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

/**
 * 가져오기 행 하나를 관문에 통과시키고 기록한다.
 *
 * @param {Object} row
 * @param {Object} deps
 * @param {string} deps.entry    - WRITE_ENTRIES.ADMIN_IMPORT 또는 CLI_IMPORT
 * @param {import("./WriteGate.js").WriteGate} deps.gate
 * @param {{ insert: Function }} [deps.writer] - FragmentWriter. dryRun이면 쓰지 않는다
 * @param {import("pg").PoolClient} [deps.client] - 호출자가 연 트랜잭션 client
 * @param {Object}  deps.defaults - IMPORT_DEFAULTS 값
 * @param {boolean} [deps.dryRun]
 * @returns {Promise<{status: "imported"|"duplicate"|"rejected", id?: string, reason?: string, warnings?: string[]}>}
 */
export async function importFragment(row, { entry, gate, writer, client, defaults, dryRun = false }) {
  let gated;
  try {
    gated = await gate.check({
      entry,
      op    : "create",
      mode  : dryRun ? "dryRun" : "production",
      fields: row,
      ctx   : { keyId: defaults.keyFromRow ? (row.key_id ?? null) : null, agentId: row.agent_id || defaults.agentId },
      build : (input) => buildImportFragment(input, defaults)
    });
  } catch (err) {
    if (!isGateRejection(err)) throw err;
    return { status: "rejected", reason: err.message };
  }

  if (dryRun) return { status: "imported", id: gated.draft.id, warnings: gated.warnings };

  const id = await writer.insert(gated.draft, { client });
  if (id == null) throw new Error("Database pool unavailable");
  return { status: id === gated.draft.id ? "imported" : "duplicate", id, warnings: gated.warnings };
}
