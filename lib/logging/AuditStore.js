/**
 * 감사 표 저장소 (admin_audit_events)
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * append는 감사 승격 소비자(lib/logging/audit-outbox.js)만 부른다. 표를 SHARE ROW EXCLUSIVE로 잠근
 * 트랜잭션 안에서 마지막 행을 읽고 seq = 마지막 + 1, prev_hash = 마지막 row_hash로 한 행을 넣는다.
 * 이 잠금 모드는 자기 자신, 그리고 INSERT, UPDATE, DELETE의 ROW EXCLUSIVE와 충돌하고 SELECT와는
 * 충돌하지 않으므로, 기록은 하나씩 이어지고 조회와 검증은 막히지 않는다. 같은 source_event(outbox
 * 멱등 키)가 이미 있으면 새 행 없이 기존 행을 돌려준다.
 *
 * list, scan, verify, cleanup은 관리 API, CLI, 주기 작업이 쓴다. cleanup은 같은 잠금 아래에서 recorded_at이
 * 보존 기간을 지난 앞부분만 지우고(마지막 행은 남긴다, recorded_at은 seq 순서를 따른다) 같은 트랜잭션에서 보존
 * 기준점 행(action audit.retention.prune, detail.boundarySeq와 boundaryHash = 지운 마지막 행의 seq와 row_hash)을
 * 체인 끝에 기록한다. verify는 남은 첫 행이 seq 1이 아니면 그 바로 앞 seq를 가리키는 기준점 행이 있고 그 해시가
 * 남은 첫 행의 prev_hash와 같을 때만 그 지점부터 검증한다. 기준점 없이 앞부분이 사라졌거나 기준점 뒤의 행이
 * 사라졌으면 prefix_mismatch다.
 *
 * seq는 기록(커밋) 순서다. occurred_at(생산자의 발생 시각) 순서와 다를 수 있다.
 */

import { withTransaction } from "../tools/db.js";
import { SCHEMA }          from "../memory/schema.js";
import {
  GENESIS_HASH, CHAIN_BREAK, computeRowHash, nextRecordedAt, startChainVerification, verifyChainRows
} from "./audit-chain.js";
import { AUDIT_OUTCOMES, isValidAuditAction, buildAuditPayload, readAuditPayload } from "./audit-event.js";

const TABLE = `${SCHEMA}.admin_audit_events`;

export const AUDIT_LIST_LIMIT_DEFAULT     = 50;
export const AUDIT_LIST_LIMIT_MAX         = 200;
export const AUDIT_SCAN_CHUNK             = 1_000;
export const AUDIT_VERIFY_MAX_ROWS        = 1_000_000;
export const AUDIT_APPEND_LOCK_TIMEOUT_MS = 10_000;
export const AUDIT_RETENTION_ACTION       = "audit.retention.prune";

const COLUMNS = `seq, source_event, occurred_at, recorded_at, action, outcome, actor_kind, actor_key_id,
  actor_session, actor_ip, target_type, target_id, workspace, detail, prev_hash, row_hash`;

const ACTION_PREFIX_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*\.$/;
const ACTOR_KINDS           = new Set(["master", "anonymous", "system"]);
const KEY_ID_PATTERN        = /^[A-Za-z0-9_-]{1,64}$/;
const TARGET_TYPE_PATTERN   = /^[a-z][a-z0-9_]{0,31}$/;

/** 조회 조건 오류. field가 문제의 질의 매개변수다. */
export class AuditQueryError extends Error {
  /**
   * @param {string} field
   * @param {string} message
   */
  constructor(field, message) {
    super(message);
    this.name  = "AuditQueryError";
    this.code  = "AUDIT_INVALID_QUERY";
    this.field = field;
  }
}

/**
 * 양의 정수 매개변수. 없으면 fallback.
 *
 * @param {URLSearchParams} params
 * @param {string} name
 * @param {{ min: number, max?: number, fallback: number|null }} range
 * @returns {number|null}
 */
function intParam(params, name, { min, max = Number.MAX_SAFE_INTEGER, fallback }) {
  const raw = params.get(name);
  if (raw === null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new AuditQueryError(name, `${name}은 ${min} 이상 ${max} 이하의 정수여야 한다`);
  }
  return value;
}

/**
 * 시각 매개변수.
 *
 * @param {URLSearchParams} params
 * @param {string} name
 * @returns {Date|null}
 */
function timeParam(params, name) {
  const raw = params.get(name);
  if (raw === null || raw === "") return null;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) throw new AuditQueryError(name, `${name}은 ISO 시각이어야 한다`);
  return date;
}

/**
 * 길이 상한이 있는 문자열 매개변수.
 *
 * @param {URLSearchParams} params
 * @param {string} name
 * @param {number} max
 * @returns {string|null}
 */
function textParam(params, name, max) {
  const raw = params.get(name);
  if (raw === null || raw === "") return null;
  if (raw.length > max) throw new AuditQueryError(name, `${name}은 ${max}자 이하여야 한다`);
  return raw;
}

/**
 * 행위 이름 조건. '.*'로 끝나면 접두어 조건이다.
 *
 * @param {string|null} raw
 * @returns {{ action: string|null, actionPrefix: string|null }}
 */
function actionFilter(raw) {
  if (raw === null) return { action: null, actionPrefix: null };
  if (raw.endsWith(".*") && ACTION_PREFIX_PATTERN.test(raw.slice(0, -1))) return { action: null, actionPrefix: raw.slice(0, -1) };
  if (isValidAuditAction(raw)) return { action: raw, actionPrefix: null };
  throw new AuditQueryError("action", "action은 행위 이름이거나 '.*'로 끝나는 접두어여야 한다");
}

/**
 * 행위자 조건. master, anonymous, system은 종류, 그 밖은 키 id다.
 *
 * @param {string|null} raw
 * @returns {{ actorKind: string|null, actorKeyId: string|null }}
 */
function actorFilter(raw) {
  if (raw === null) return { actorKind: null, actorKeyId: null };
  if (ACTOR_KINDS.has(raw)) return { actorKind: raw, actorKeyId: null };
  if (KEY_ID_PATTERN.test(raw)) return { actorKind: null, actorKeyId: raw };
  throw new AuditQueryError("actor", "actor는 master, anonymous, system 또는 키 id여야 한다");
}

/**
 * 질의 매개변수를 조회 조건으로 바꾼다.
 *
 * 매개변수: action, actor, target_type, target_id, outcome, workspace, from, to(occurred_at 구간, to 미포함),
 * before(이 seq 미만), limit(목록 쪽 크기)
 *
 * @param {URLSearchParams} params
 * @returns {object}
 */
export function parseAuditFilters(params) {
  const targetType = textParam(params, "target_type", 32);
  if (targetType !== null && !TARGET_TYPE_PATTERN.test(targetType)) {
    throw new AuditQueryError("target_type", "target_type은 소문자로 시작하는 이름이어야 한다");
  }
  const outcome = textParam(params, "outcome", 16);
  if (outcome !== null && !AUDIT_OUTCOMES.includes(outcome)) {
    throw new AuditQueryError("outcome", `outcome은 ${AUDIT_OUTCOMES.join(", ")} 중 하나다`);
  }
  return {
    ...actionFilter(textParam(params, "action", 64)),
    ...actorFilter(textParam(params, "actor", 64)),
    targetType,
    targetId : textParam(params, "target_id", 200),
    outcome,
    workspace: textParam(params, "workspace", 128),
    from     : timeParam(params, "from"),
    to       : timeParam(params, "to"),
    before   : intParam(params, "before", { min: 1, fallback: null }),
    limit    : intParam(params, "limit", { min: 1, max: AUDIT_LIST_LIMIT_MAX, fallback: AUDIT_LIST_LIMIT_DEFAULT })
  };
}

/**
 * 조회 조건의 WHERE 절과 매개변수. 매개변수 번호는 $1부터다.
 *
 * @param {object} filters parseAuditFilters 결과
 * @returns {{ sql: string, params: unknown[] }}
 */
export function auditWhereClause(filters) {
  const clauses = [];
  const params  = [];
  const add     = (sql, value) => {
    params.push(value);
    clauses.push(sql.replace("?", `$${params.length}`));
  };
  if (filters.action)       add("action = ?", filters.action);
  if (filters.actionPrefix) add("action LIKE ?", `${filters.actionPrefix.replace(/_/g, "\\_")}%`);
  if (filters.actorKind)    add("actor_kind = ?", filters.actorKind);
  if (filters.actorKeyId)   add("actor_key_id = ?", filters.actorKeyId);
  if (filters.targetType)   add("target_type = ?", filters.targetType);
  if (filters.targetId)     add("target_id = ?", filters.targetId);
  if (filters.outcome)      add("outcome = ?", filters.outcome);
  if (filters.workspace)    add("workspace = ?", filters.workspace);
  if (filters.from)         add("occurred_at >= ?", filters.from);
  if (filters.to)           add("occurred_at < ?", filters.to);
  if (filters.before)       add("seq < ?", filters.before);
  return { sql: clauses.length ? clauses.join(" AND ") : "TRUE", params };
}

/**
 * DB 행을 응답과 검증에 쓰는 값으로 바꾼다.
 *
 * @param {object} row
 * @returns {object}
 */
export function toAuditEvent(row) {
  return {
    seq         : Number(row.seq),
    sourceEvent : row.source_event,
    occurredAt  : new Date(row.occurred_at).toISOString(),
    recordedAt  : new Date(row.recorded_at).toISOString(),
    action      : row.action,
    outcome     : row.outcome,
    actorKind   : row.actor_kind,
    actorKeyId  : row.actor_key_id ?? null,
    actorSession: row.actor_session ?? null,
    actorIp     : row.actor_ip ?? null,
    targetType  : row.target_type ?? null,
    targetId    : row.target_id ?? null,
    workspace   : row.workspace ?? null,
    detail      : row.detail ?? {},
    prevHash    : row.prev_hash,
    rowHash     : row.row_hash
  };
}

/**
 * 체인 기록 잠금. 기록과 보존 정리를 하나씩 잇고 조회는 막지 않는다.
 *
 * @param {import("pg").PoolClient} client
 */
async function lockChain(client) {
  await client.query(`SET LOCAL lock_timeout = '${AUDIT_APPEND_LOCK_TIMEOUT_MS}ms'`);
  await client.query(`LOCK TABLE ${TABLE} IN SHARE ROW EXCLUSIVE MODE`);
}

/**
 * 처음부터 끊긴 검증 상태.
 *
 * @param {number} seq
 * @param {string} reason
 * @returns {object}
 */
function brokenAt(seq, reason) {
  return { ...startChainVerification({ expectedSeq: seq }), broken: { seq, reason } };
}

/**
 * 보존 기준점 행 값. 지운 마지막 행의 seq와 row_hash를 담는 시스템 감사 행이다.
 *
 * @param {{ boundarySeq: number, boundaryHash: string, deleted: number, retentionDays: number }} args
 * @returns {object} readAuditPayload 결과
 */
export function retentionCheckpoint({ boundarySeq, boundaryHash, deleted, retentionDays }) {
  return readAuditPayload(buildAuditPayload({
    action: AUDIT_RETENTION_ACTION,
    actor : "system",
    target: { type: "audit_chain", id: String(boundarySeq) },
    detail: { boundarySeq, boundaryHash, deleted, retentionDays }
  }));
}

export class AuditStore {
  /**
   * @param {import("pg").Pool} pool
   * @param {{ clock?: () => number }} [options]
   */
  constructor(pool, { clock = Date.now } = {}) {
    this.pool  = pool;
    this.clock = clock;
  }

  /**
   * 체인 끝에 한 행을 기록한다.
   *
   * @param {object} record      readAuditPayload 결과
   * @param {string} sourceEvent outbox 멱등 키
   * @returns {Promise<{ seq: number, rowHash: string, duplicate: boolean }>}
   */
  async append(record, sourceEvent) {
    return withTransaction(this.pool, async (client) => {
      await lockChain(client);
      return this._appendLocked(client, record, sourceEvent);
    });
  }

  /**
   * 잠금을 쥔 트랜잭션 안에서 체인 끝에 한 행을 기록한다.
   *
   * @param {import("pg").PoolClient} client
   * @param {object} record
   * @param {string} sourceEvent
   * @returns {Promise<{ seq: number, rowHash: string, duplicate: boolean }>}
   */
  async _appendLocked(client, record, sourceEvent) {
    const dup = await client.query(`SELECT seq, row_hash FROM ${TABLE} WHERE source_event = $1`, [sourceEvent]);
    if (dup.rows.length > 0) return { seq: Number(dup.rows[0].seq), rowHash: dup.rows[0].row_hash, duplicate: true };

    const last       = (await client.query(`SELECT seq, row_hash, recorded_at FROM ${TABLE} ORDER BY seq DESC LIMIT 1`)).rows[0];
    const seq        = last ? Number(last.seq) + 1 : 1;
    const prevHash   = last ? last.row_hash : GENESIS_HASH;
    const recordedAt = nextRecordedAt(this.clock(), last?.recorded_at ?? null);
    const row        = { ...record, seq, sourceEvent, recordedAt };
    const rowHash    = computeRowHash(prevHash, row);

    await client.query(
      `INSERT INTO ${TABLE} (${COLUMNS})
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15, $16)`,
      [seq, sourceEvent, record.occurredAt, recordedAt, record.action, record.outcome, record.actorKind,
        record.actorKeyId, record.actorSession, record.actorIp, record.targetType, record.targetId,
        record.workspace, JSON.stringify(record.detail ?? {}), prevHash, rowHash]
    );
    return { seq, rowHash, duplicate: false };
  }

  /**
   * 조건에 맞는 행을 최근 순으로 한 쪽 돌려준다.
   *
   * @param {object} filters parseAuditFilters 결과
   * @returns {Promise<{ events: object[], nextBefore: number|null }>}
   */
  async list(filters) {
    const where    = auditWhereClause(filters);
    const { rows } = await this.pool.query(
      `SELECT ${COLUMNS} FROM ${TABLE} WHERE ${where.sql} ORDER BY seq DESC LIMIT $${where.params.length + 1}`,
      [...where.params, filters.limit]
    );
    const events = rows.map(toAuditEvent);
    return { events, nextBefore: events.length === filters.limit ? events.at(-1).seq : null };
  }

  /**
   * 조건에 맞는 행을 seq 오름차순으로 묶음 단위로 읽는다.
   *
   * @param {object} filters parseAuditFilters 결과(limit은 쓰지 않는다)
   * @param {{ chunk?: number }} [options]
   * @returns {AsyncGenerator<object>}
   */
  async *scan(filters, { chunk = AUDIT_SCAN_CHUNK } = {}) {
    const where = auditWhereClause(filters);
    const n     = where.params.length;
    let   after = 0;
    for (;;) {
      const { rows } = await this.pool.query(
        `SELECT ${COLUMNS} FROM ${TABLE} WHERE ${where.sql} AND seq > $${n + 1} ORDER BY seq LIMIT $${n + 2}`,
        [...where.params, after, chunk]
      );
      for (const row of rows) yield toAuditEvent(row);
      if (rows.length < chunk) return;
      after = Number(rows.at(-1).seq);
    }
  }

  /**
   * 기준점을 정한다. fromSeq가 남은 첫 행보다 뒤면 바로 앞 행(없으면 seq_gap), 첫 행이 seq 1이면 GENESIS_HASH,
   * 앞부분이 정리됐으면 그 경계를 가리키는 보존 기준점 행의 boundaryHash(없거나 맞지 않으면 prefix_mismatch)다.
   *
   * @param {number|null} fromSeq
   * @returns {Promise<{ anchor: string|null, state: object|null, after: number }>}
   */
  async _verificationStart(fromSeq) {
    const { rows } = await this.pool.query(`SELECT min(seq) AS min FROM ${TABLE}`);
    const minSeq   = rows[0]?.min == null ? null : Number(rows[0].min);
    if (minSeq === null) return { anchor: null, state: null, after: 0 };

    if (fromSeq !== null && fromSeq > minSeq) {
      const prev = (await this.pool.query(`SELECT row_hash FROM ${TABLE} WHERE seq = $1`, [fromSeq - 1])).rows[0];
      return prev
        ? { anchor: "previous_row", state: startChainVerification({ prevHash: prev.row_hash, expectedSeq: fromSeq }), after: fromSeq - 1 }
        : { anchor: "previous_row", state: brokenAt(fromSeq, CHAIN_BREAK.SEQ_GAP), after: fromSeq - 1 };
    }
    if (minSeq === 1) return { anchor: "genesis", state: startChainVerification({ prevHash: GENESIS_HASH, expectedSeq: 1 }), after: 0 };

    const boundaryHash = await this._checkpointHash(minSeq);
    return boundaryHash
      ? { anchor: "checkpoint", state: startChainVerification({ prevHash: boundaryHash, expectedSeq: minSeq }), after: minSeq - 1 }
      : { anchor: "checkpoint", state: brokenAt(minSeq, CHAIN_BREAK.PREFIX_MISMATCH), after: minSeq - 1 };
  }

  /**
   * 남은 첫 행(minSeq) 바로 앞을 경계로 기록한 보존 기준점의 boundaryHash. 기준점이 없거나 남은 첫 행의
   * prev_hash와 다르면 null이다. 기준점 행 자신의 해시는 체인 검증에서 확인된다.
   *
   * @param {number} minSeq
   * @returns {Promise<string|null>}
   */
  async _checkpointHash(minSeq) {
    const { rows } = await this.pool.query(
      `SELECT c.detail->>'boundaryHash' AS boundary_hash, f.prev_hash
         FROM ${TABLE} c, ${TABLE} f
        WHERE c.action = $1 AND c.detail->>'boundarySeq' = $2 AND f.seq = $3
        ORDER BY c.seq DESC LIMIT 1`,
      [AUDIT_RETENTION_ACTION, String(minSeq - 1), minSeq]
    );
    const row = rows[0];
    return row && row.boundary_hash === row.prev_hash ? row.boundary_hash : null;
  }

  /**
   * 체인을 seq 순으로 다시 계산해 확인한다.
   *
   * @param {{ fromSeq?: number|null, maxRows?: number, chunk?: number }} [options]
   * @returns {Promise<{ ok: boolean, checked: number, firstSeq: number|null, lastSeq: number|null, anchor: string|null,
   *                     anchorHash: string|null, headHash: string|null, complete: boolean,
   *                     broken: { seq: number, reason: string }|null }>}
   */
  async verify({ fromSeq = null, maxRows = AUDIT_VERIFY_MAX_ROWS, chunk = AUDIT_SCAN_CHUNK } = {}) {
    const start = await this._verificationStart(fromSeq);
    let   state = start.state;
    if (!state) {
      return { ok: true, checked: 0, firstSeq: null, lastSeq: null, anchor: null, anchorHash: null, headHash: null, complete: true, broken: null };
    }

    let after    = start.after;
    let complete = false;
    while (!state.broken && state.checked < maxRows) {
      const limit    = Math.min(chunk, maxRows - state.checked);
      const { rows } = await this.pool.query(
        `SELECT ${COLUMNS} FROM ${TABLE} WHERE seq > $1 ORDER BY seq LIMIT $2`, [after, limit]);
      state = verifyChainRows(state, rows.map(toAuditEvent));
      if (rows.length < limit) {
        complete = true;
        break;
      }
      after = Number(rows.at(-1).seq);
    }
    return {
      ok        : state.broken === null,
      checked   : state.checked,
      firstSeq  : state.firstSeq,
      lastSeq   : state.lastSeq,
      anchor    : state.firstSeq === null && state.broken === null ? null : start.anchor,
      anchorHash: state.anchorHash,
      headHash  : state.checked > 0 && state.broken === null ? state.prevHash : null,
      complete  : complete && state.broken === null,
      broken    : state.broken
    };
  }

  /**
   * 보존 기간이 지난 앞부분을 묶음 하나만큼 지우고 같은 트랜잭션에서 보존 기준점 행을 체인 끝에 기록한다.
   * 마지막 행은 지우지 않는다. 지울 행이 없으면 아무것도 쓰지 않는다.
   *
   * @param {{ retentionDays: number, limit: number }} args
   * @returns {Promise<number>} 지운 행 수
   */
  async cleanup({ retentionDays, limit }) {
    return withTransaction(this.pool, async (client) => {
      await lockChain(client);
      const boundary = (await client.query(
        `SELECT b.seq, b.row_hash FROM ${TABLE} b
          WHERE b.seq = (SELECT max(seq) FROM (
                  SELECT seq FROM ${TABLE}
                   WHERE recorded_at < now() - make_interval(days => $1)
                     AND seq < (SELECT max(seq) FROM ${TABLE})
                   ORDER BY seq
                   LIMIT $2) d)`,
        [retentionDays, limit]
      )).rows[0];
      if (!boundary) return 0;

      const boundarySeq = Number(boundary.seq);
      const deleted     = (await client.query(`DELETE FROM ${TABLE} WHERE seq <= $1`, [boundarySeq])).rowCount ?? 0;
      await this._appendLocked(client, retentionCheckpoint({ boundarySeq, boundaryHash: boundary.row_hash, deleted, retentionDays }),
        `audit.retention:${boundarySeq}`);
      return deleted;
    });
  }
}
