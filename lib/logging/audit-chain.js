/**
 * 감사 해시 체인 계산과 검증 (순수 함수)
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * admin_audit_events의 행은 하나의 순차 체인을 이룬다.
 *
 *   row_hash(n) = sha256(prev_hash(n) + "\n" + canonicalJson(chainRecord(row n)))
 *   prev_hash(n) = row_hash(n - 1), 첫 행은 GENESIS_HASH
 *
 * 정규 JSON은 객체 키를 사전순으로 정렬하고 공백 없이 직렬화한다. jsonb로 저장했다가 다시 읽은
 * detail도 같은 문자열이 된다(jsonb는 키 순서와 공백만 바꾸고, detail에 들어가는 문자열, 유한한 수,
 * 불리언, null은 같은 값으로 돌려준다).
 * 시각은 밀리초 ISO 문자열로, seq는 10진 문자열로 넣는다.
 *
 * 검증은 행을 seq 오름차순으로 받아 seq 연속성, prev_hash 연결, row_hash 재계산을 차례로 본다.
 * 행 하나의 값이 바뀌면 그 행의 row_hash가, 행이 빠지거나 끼어들면 seq나 prev_hash 연결이 어긋난다.
 * 보존 정리로 앞부분이 지워진 체인은 남은 첫 행의 prev_hash를 기준점으로 삼는다.
 */

import crypto from "node:crypto";

export const GENESIS_HASH = "0".repeat(64);

/** 검증 실패 사유 */
export const CHAIN_BREAK = Object.freeze({
  SEQ_GAP      : "seq_gap",
  PREV_MISMATCH: "prev_hash_mismatch",
  HASH_MISMATCH: "row_hash_mismatch"
});

/** 체인 값이 정규화할 수 없는 형태일 때 던진다. */
export class AuditChainValueError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "AuditChainValueError";
  }
}

/**
 * 키를 사전순으로 정렬한 JSON 문자열. undefined, 함수, 유한하지 않은 수는 받지 않는다.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new AuditChainValueError("유한한 수만 체인에 넣을 수 있다");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  throw new AuditChainValueError(`체인에 넣을 수 없는 값의 형태: ${typeof value}`);
}

/**
 * 시각 값을 밀리초 ISO 문자열로 바꾼다.
 *
 * @param {Date|string} value
 * @returns {string}
 */
function isoTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new AuditChainValueError("시각 값을 읽을 수 없다");
  return date.toISOString();
}

/**
 * 해시에 들어가는 행 값. 열 목록과 이름은 이 함수가 정한다.
 *
 * @param {{ seq: number|string, sourceEvent: string, occurredAt: Date|string, recordedAt: Date|string,
 *           action: string, outcome: string, actorKind: string, actorKeyId?: string|null,
 *           actorSession?: string|null, actorIp?: string|null, targetType?: string|null,
 *           targetId?: string|null, workspace?: string|null, detail?: object }} row
 * @returns {object}
 */
export function chainRecord(row) {
  return {
    seq         : String(row.seq),
    sourceEvent : row.sourceEvent,
    occurredAt  : isoTime(row.occurredAt),
    recordedAt  : isoTime(row.recordedAt),
    action      : row.action,
    outcome     : row.outcome,
    actorKind   : row.actorKind,
    actorKeyId  : row.actorKeyId ?? null,
    actorSession: row.actorSession ?? null,
    actorIp     : row.actorIp ?? null,
    targetType  : row.targetType ?? null,
    targetId    : row.targetId ?? null,
    workspace   : row.workspace ?? null,
    detail      : row.detail ?? {}
  };
}

/**
 * 행의 row_hash.
 *
 * @param {string} prevHash
 * @param {object} row chainRecord가 받는 값
 * @returns {string} 소문자 16진 64자
 */
export function computeRowHash(prevHash, row) {
  return crypto.createHash("sha256")
    .update(`${prevHash}\n${canonicalJson(chainRecord(row))}`, "utf8")
    .digest("hex");
}

/**
 * 새 행의 기록 시각. 앞 행보다 이르지 않게 맞춰 기록 시각이 seq 순서를 따르게 한다.
 *
 * @param {number} nowMs
 * @param {Date|string|null} lastRecordedAt
 * @returns {Date}
 */
export function nextRecordedAt(nowMs, lastRecordedAt) {
  const last = lastRecordedAt == null ? Number.NEGATIVE_INFINITY : new Date(lastRecordedAt).getTime();
  return new Date(Math.max(nowMs, last));
}

/**
 * 검증 시작 상태.
 *
 * @param {{ prevHash?: string|null, expectedSeq?: number|null }} [anchor]
 *   prevHash: 첫 행이 이어야 할 해시(없으면 첫 행의 prev_hash를 기준점으로 받는다)
 *   expectedSeq: 첫 행이 가져야 할 seq(없으면 첫 행의 seq를 받는다)
 * @returns {{ prevHash: string|null, expectedSeq: number|null, checked: number, firstSeq: number|null,
 *             lastSeq: number|null, anchorHash: string|null, broken: { seq: number, reason: string }|null }}
 */
export function startChainVerification({ prevHash = null, expectedSeq = null } = {}) {
  return { prevHash, expectedSeq, checked: 0, firstSeq: null, lastSeq: null, anchorHash: null, broken: null };
}

/**
 * 행 묶음을 이어서 검증한다. 이미 끊긴 상태면 그대로 돌려준다. 입력 상태를 바꾸지 않는다.
 *
 * @param {ReturnType<typeof startChainVerification>} state
 * @param {Array<object>} rows seq 오름차순. chainRecord 값과 prevHash, rowHash를 가진다
 * @returns {ReturnType<typeof startChainVerification>}
 */
export function verifyChainRows(state, rows) {
  let next = { ...state };
  for (const row of rows) {
    if (next.broken) break;
    const seq = Number(row.seq);
    if (next.firstSeq === null) {
      next.firstSeq    = seq;
      next.anchorHash  = next.prevHash ?? row.prevHash;
      next.prevHash    = next.anchorHash;
      next.expectedSeq = next.expectedSeq ?? seq;
    }
    if (seq !== next.expectedSeq) {
      next.broken = { seq, reason: CHAIN_BREAK.SEQ_GAP };
      break;
    }
    if (row.prevHash !== next.prevHash) {
      next.broken = { seq, reason: CHAIN_BREAK.PREV_MISMATCH };
      break;
    }
    if (computeRowHash(row.prevHash, row) !== row.rowHash) {
      next.broken = { seq, reason: CHAIN_BREAK.HASH_MISMATCH };
      break;
    }
    next = { ...next, prevHash: row.rowHash, expectedSeq: seq + 1, checked: next.checked + 1, lastSeq: seq };
  }
  return next;
}
