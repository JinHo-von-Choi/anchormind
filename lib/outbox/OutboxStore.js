/**
 * outbox_events 표 질의
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 문장마다 자동 커밋으로 실행한다. 처리기를 실행하는 동안 트랜잭션이나 행 잠금을 쥐지 않는다.
 *
 * 점유(claim): 대기 행 중 available_at이 지난 행을 (available_at, id) 순으로 FOR UPDATE SKIP LOCKED로
 * 고르고, 같은 문장에서 attempts를 1 늘리며 available_at을 임대 만료 시각(now() + leaseMs)으로, claim_token을
 * 이번 점유의 표지로 바꾼다. 두 작업자가 동시에 점유하면 한쪽이 잠근 행은 다른 쪽이 건너뛰고, 커밋된
 * 점유 행은 available_at이 미래이므로 다시 고르지 않는다. 작업자가 죽으면 임대 만료 뒤 다른 작업자가
 * 같은 행을 다시 점유한다.
 *
 * 완료, 실패, 반납은 claim_token이 같고 행이 아직 대기 상태일 때만 반영한다. 임대를 잃은 작업자의
 * 늦은 기록은 0행이 되어 다른 작업자의 점유를 덮어쓰지 않는다.
 *
 * 시각은 모두 DB의 now()로 정한다. 여러 인스턴스의 시계 차이가 임대에 끼어들지 않는다.
 */

import { SCHEMA } from "../memory/schema.js";

const TABLE   = `${SCHEMA}.outbox_events`;
const PENDING = "processed_at IS NULL AND dead_at IS NULL";

const CLAIM_SQL = `
  WITH due AS (
    SELECT id, available_at AS due_at
      FROM ${TABLE}
     WHERE ${PENDING}
       AND available_at <= now()
       AND topic = ANY($1::text[])
     ORDER BY available_at, id
     LIMIT $2
     FOR UPDATE SKIP LOCKED
  )
  UPDATE ${TABLE} AS e
     SET attempts     = e.attempts + 1,
         available_at = now() + make_interval(secs => $3::double precision / 1000),
         claim_token  = $4::uuid
    FROM due
   WHERE e.id = due.id
  RETURNING e.id, e.topic, e.aggregate_id, e.payload, e.attempts, e.created_at, due.due_at`;

const COMPLETE_SQL = `
  UPDATE ${TABLE}
     SET processed_at = now(), claim_token = NULL, last_error = NULL
   WHERE id = $1 AND claim_token = $2::uuid AND ${PENDING}
  RETURNING EXTRACT(EPOCH FROM (processed_at - COALESCE($3::timestamptz, created_at)))::float8 AS delivery_seconds`;

const FAIL_SQL = `
  UPDATE ${TABLE}
     SET available_at = now() + make_interval(secs => $3::double precision / 1000),
         last_error   = $4,
         claim_token  = NULL,
         dead_at      = CASE WHEN $5::boolean THEN now() ELSE NULL END
   WHERE id = $1 AND claim_token = $2::uuid AND ${PENDING}`;

const RELEASE_SQL = `
  UPDATE ${TABLE}
     SET available_at = now(), attempts = GREATEST(attempts - 1, 0), claim_token = NULL
   WHERE id = ANY($1::bigint[]) AND claim_token = $2::uuid AND ${PENDING}`;

const CLEANUP_SQL = `
  DELETE FROM ${TABLE}
   WHERE id IN (
     SELECT id
       FROM ${TABLE}
      WHERE processed_at IS NOT NULL
        AND processed_at < now() - make_interval(days => $1::int)
      ORDER BY processed_at
      LIMIT $2
      FOR UPDATE SKIP LOCKED)`;

const UNHANDLED_SQL = `
  UPDATE ${TABLE}
     SET dead_at = now(), last_error = 'no_handler', claim_token = NULL
   WHERE id IN (
     SELECT id
       FROM ${TABLE}
      WHERE ${PENDING}
        AND attempts = 0
        AND available_at < now() - make_interval(days => $2::int)
        AND NOT (topic = ANY($1::text[]))
      ORDER BY available_at, id
      LIMIT $3
      FOR UPDATE SKIP LOCKED)`;

const TOPIC_FILTER = "($1::text IS NULL OR topic = $1)";

const STATS_SQL = `
  SELECT (SELECT count(*) FROM ${TABLE} WHERE ${PENDING} AND ${TOPIC_FILTER})::bigint          AS pending,
         (SELECT count(*) FROM ${TABLE} WHERE dead_at IS NOT NULL AND ${TOPIC_FILTER})::bigint AS dead,
         COALESCE((SELECT EXTRACT(EPOCH FROM now() - min(available_at))
                     FROM ${TABLE}
                    WHERE ${PENDING} AND available_at <= now() AND ${TOPIC_FILTER}), 0)::float8 AS lag_seconds`;

/**
 * 점유 결과 행을 처리기에 넘길 이벤트로 바꾼다.
 *
 * @param {object} row
 * @returns {{ id: string, topic: string, aggregateId: string|null, payload: object, attempts: number, createdAt: Date, dueAt: Date }}
 */
function toEvent(row) {
  return {
    id         : String(row.id),
    topic      : row.topic,
    aggregateId: row.aggregate_id ?? null,
    payload    : row.payload ?? {},
    attempts   : Number(row.attempts),
    createdAt  : row.created_at,
    dueAt      : row.due_at
  };
}

/**
 * 점유 순서: 점유 전 available_at, 그다음 id. RETURNING은 순서를 보장하지 않으므로 다시 정렬한다.
 *
 * @param {{ id: string, dueAt: Date }} a
 * @param {{ id: string, dueAt: Date }} b
 * @returns {number}
 */
function claimOrder(a, b) {
  const byDue = new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime();
  if (byDue !== 0) return byDue;
  return BigInt(a.id) < BigInt(b.id) ? -1 : (BigInt(a.id) > BigInt(b.id) ? 1 : 0);
}

export class OutboxStore {
  /**
   * @param {{ query: Function }} pool pg Pool 또는 같은 query 계약을 가진 객체
   */
  constructor(pool) {
    this.pool = pool;
  }

  /**
   * 대기 행을 점유한다.
   *
   * @param {{ topics: string[], limit: number, leaseMs: number, token: string }} args
   * @returns {Promise<Array<object>>} 점유 순서로 정렬한 이벤트
   */
  async claim({ topics, limit, leaseMs, token }) {
    const { rows } = await this.pool.query(CLAIM_SQL, [topics, limit, leaseMs, token]);
    return rows.map(toEvent).sort(claimOrder);
  }

  /**
   * 완료를 기록한다. 전달 시간은 이번 점유 전의 available_at(전달 예정 시각)부터 잰다.
   *
   * @param {string} id
   * @param {string} token
   * @param {Date|null} [dueAt] 점유 전 available_at. 없으면 created_at부터 잰다
   * @returns {Promise<{ applied: boolean, deliverySeconds: number|null }>}
   */
  async complete(id, token, dueAt = null) {
    const { rows } = await this.pool.query(COMPLETE_SQL, [id, token, dueAt]);
    if (rows.length === 0) return { applied: false, deliverySeconds: null };
    return { applied: true, deliverySeconds: Number(rows[0].delivery_seconds) };
  }

  /**
   * 실패를 기록한다. dead이면 dead-letter로, 아니면 retryDelayMs 뒤 다시 점유할 수 있게 둔다.
   *
   * @param {string} id
   * @param {string} token
   * @param {{ retryDelayMs: number, error: string, dead: boolean }} outcome
   * @returns {Promise<boolean>} 반영 여부
   */
  async fail(id, token, { retryDelayMs, error, dead }) {
    const result = await this.pool.query(FAIL_SQL, [id, token, retryDelayMs, error, dead]);
    return result.rowCount === 1;
  }

  /**
   * 처리하지 않은 점유를 돌려준다. 점유로 늘린 attempts를 되돌리고 곧바로 다시 점유할 수 있게 둔다.
   *
   * @param {string[]} ids
   * @param {string} token
   * @returns {Promise<number>} 돌려준 행 수
   */
  async release(ids, token) {
    if (ids.length === 0) return 0;
    const result = await this.pool.query(RELEASE_SQL, [ids, token]);
    return result.rowCount;
  }

  /**
   * 보존 기간이 지난 완료 행을 limit건까지 지운다.
   *
   * @param {{ retentionDays: number, limit: number }} args
   * @returns {Promise<number>} 지운 행 수
   */
  async cleanup({ retentionDays, limit }) {
    const result = await this.pool.query(CLEANUP_SQL, [retentionDays, limit]);
    return result.rowCount;
  }

  /**
   * topics에 없는 topic의 대기 행 중 한 번도 점유되지 않았고(attempts = 0) 전달 예정 시각이 olderThanDays일
   * 넘게 지난 행을 limit건까지 dead-letter(last_error 'no_handler')로 옮긴다. 판정은 호출한 프로세스에 등록된
   * topic 목록 기준이다. 점유 중이거나 점유된 적이 있는 행은 대상이 아니다. 빈 목록은 호출하지 않는다(작업자가 막는다).
   *
   * @param {{ topics: string[], olderThanDays: number, limit: number }} args topics: 이 프로세스에 처리기가 등록된 topic
   * @returns {Promise<number>} 옮긴 행 수
   */
  async deadLetterUnhandled({ topics, olderThanDays, limit }) {
    const result = await this.pool.query(UNHANDLED_SQL, [topics, olderThanDays, limit]);
    return result.rowCount;
  }

  /**
   * 대기 행 수, dead-letter 행 수, 전달 예정 시각이 지난 대기 행 중 가장 오래된 행의 지연 초.
   *
   * 재시도 대기와 delayMs로 미룬 행처럼 아직 예정 시각이 오지 않은 행과 점유 중인 행은 지연에 넣지 않는다.
   *
   * @param {{ topic?: string|null }} [filter] topic을 주면 그 topic의 행만 센다
   * @returns {Promise<{ pending: number, dead: number, lagSeconds: number }>}
   */
  async stats({ topic = null } = {}) {
    const { rows } = await this.pool.query(STATS_SQL, [topic]);
    const row      = rows[0] ?? {};
    return {
      pending   : Number(row.pending ?? 0),
      dead      : Number(row.dead ?? 0),
      lagSeconds: Math.max(0, Number(row.lag_seconds ?? 0))
    };
  }
}
