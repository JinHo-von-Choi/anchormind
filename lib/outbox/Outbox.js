/**
 * 트랜잭션 outbox 기록
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 생산자는 업무 변경과 같은 트랜잭션 연결로 enqueue(client, event)를 부른다. 행은 그 트랜잭션과
 * 함께 커밋되거나 함께 사라진다. 전달은 OutboxWorker가 맡는다.
 *
 * 트랜잭션 연결 요구
 *   - client는 풀에서 빌린 연결(release가 있는 객체)이어야 한다. 풀 객체를 넘기면 질의 없이 거부한다.
 *   - client.getTransactionStatus()가 "T"(트랜잭션 블록 안)여야 한다. pg 클라이언트는 서버가 매 응답 끝의
 *     ReadyForQuery로 알려 준 트랜잭션 상태를 이 값으로 돌려준다("I" 블록 밖, "T" 블록 안, "E" 실패한 블록).
 *     BEGIN 없이 빌린 연결이나 실패한 트랜잭션에서는 질의 없이 거부한다. 추가 왕복은 없다.
 *   - 업무 변경 없이 독립적으로 남겨야 하는 이벤트(관문 차단, 인증 실패)는 enqueueStandalone(pool, event)로
 *     짧은 독립 트랜잭션에 기록한다.
 *
 * payload에는 기억 본문을 담지 않는다. 감사류 이벤트는 해시와 길이만 담는다. 크기 상한은
 * 직렬화한 UTF-8 바이트 기준 PAYLOAD_MAX_BYTES다.
 *
 * MEMENTO_OUTBOX=off이면 enqueue와 enqueueStandalone은 행을 쓰지 않고 null을 돌려준다. 그동안 생산한 이벤트는
 * 나중에 기록되지 않고 사라진다. 연결과 이벤트 검사는 스위치와 관계없이 먼저 한다(생산자 계약 오류가 off에서도
 * 드러난다).
 */

import { outboxEnabled }                        from "../config.js";
import { withTransaction }                      from "../tools/db.js";
import { SCHEMA }                               from "../memory/schema.js";
import { isValidTopic }                         from "./OutboxHandlers.js";
import { outboxEnqueuedTotal, topicLabel }      from "./outbox-metrics.js";

export const PAYLOAD_MAX_BYTES       = 131_072;
export const AGGREGATE_ID_MAX_LENGTH = 200;
export const MAX_DELAY_MS            = 30 * 86_400_000;

/** 입력 검증 오류. field가 문제의 필드다. */
export class OutboxValidationError extends Error {
  /**
   * @param {string} field
   * @param {string} message
   */
  constructor(field, message) {
    super(message);
    this.name  = "OutboxValidationError";
    this.code  = "OUTBOX_INVALID_EVENT";
    this.field = field;
  }
}

/** 트랜잭션 연결이 아니어서 기록하지 않았음을 알리는 오류. */
export class OutboxTransactionRequiredError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "OutboxTransactionRequiredError";
    this.code = "OUTBOX_TRANSACTION_REQUIRED";
  }
}

const INSERT_SQL = `
  INSERT INTO ${SCHEMA}.outbox_events (topic, aggregate_id, payload, available_at)
  VALUES ($1, $2, $3::jsonb, now() + make_interval(secs => $4::double precision / 1000))
  RETURNING id`;

/** pg 클라이언트가 보고하는 트랜잭션 블록 안 상태 */
const IN_TRANSACTION = "T";

/**
 * payload를 직렬화한다. 일반 객체만 받고 크기 상한을 넘으면 거부한다.
 *
 * @param {unknown} payload
 * @returns {string}
 */
function serializePayload(payload) {
  if (payload === undefined) return "{}";
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new OutboxValidationError("payload", "payload는 일반 객체여야 한다");
  }
  let json;
  try {
    json = JSON.stringify(payload);
  } catch (err) {
    throw new OutboxValidationError("payload", `payload를 직렬화할 수 없다: ${err.message}`);
  }
  if (Buffer.byteLength(json, "utf8") > PAYLOAD_MAX_BYTES) {
    throw new OutboxValidationError("payload", `payload가 ${PAYLOAD_MAX_BYTES}바이트를 넘는다`);
  }
  return json;
}

/**
 * aggregateId를 검사한다. 생략하면 null이다.
 *
 * @param {unknown} aggregateId
 * @returns {string|null}
 */
function checkedAggregateId(aggregateId) {
  if (aggregateId === undefined || aggregateId === null) return null;
  if (typeof aggregateId !== "string" || aggregateId.length === 0 || aggregateId.length > AGGREGATE_ID_MAX_LENGTH) {
    throw new OutboxValidationError("aggregateId", `aggregateId는 1자 이상 ${AGGREGATE_ID_MAX_LENGTH}자 이하의 문자열이어야 한다`);
  }
  return aggregateId;
}

/**
 * delayMs를 검사한다. 생략하면 0이다.
 *
 * @param {unknown} delayMs
 * @returns {number}
 */
function checkedDelay(delayMs) {
  if (delayMs === undefined) return 0;
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > MAX_DELAY_MS) {
    throw new OutboxValidationError("delayMs", `delayMs는 0 이상 ${MAX_DELAY_MS} 이하의 정수여야 한다`);
  }
  return delayMs;
}

/**
 * 이벤트 입력을 검사해 기록 값으로 바꾼다.
 *
 * @param {{ topic: string, aggregateId?: string|null, payload?: object, delayMs?: number }} event
 * @returns {{ topic: string, aggregateId: string|null, payloadJson: string, delayMs: number }}
 */
export function normalizeOutboxEvent(event) {
  const source = event ?? {};
  if (!isValidTopic(source.topic)) {
    throw new OutboxValidationError("topic", "topic은 점으로 구분한 소문자 조각이고 64자 이하여야 한다");
  }
  return {
    topic      : source.topic,
    aggregateId: checkedAggregateId(source.aggregateId),
    payloadJson: serializePayload(source.payload),
    delayMs    : checkedDelay(source.delayMs)
  };
}

/**
 * 소비자 멱등 키. 같은 이벤트의 재전달은 같은 키를 갖는다.
 *
 * @param {{ topic: string, id: string|number }} event
 * @returns {string}
 */
export function idempotencyKey(event) {
  return `${event.topic}:${String(event.id)}`;
}

/**
 * 풀에서 빌린 연결인지 확인한다.
 *
 * @param {unknown} client
 */
function assertPoolClient(client) {
  if (!client || typeof client.query !== "function" || typeof client.release !== "function") {
    throw new OutboxTransactionRequiredError("outbox enqueue는 트랜잭션을 연 연결(pool.connect()로 빌린 연결)을 받는다");
  }
}

/**
 * 연결이 트랜잭션 블록 안에 있는지 확인한다. 상태를 알 수 없는 연결도 거부한다.
 *
 * @param {{ getTransactionStatus?: () => string|null }} client
 */
function assertInTransaction(client) {
  const status = typeof client.getTransactionStatus === "function" ? client.getTransactionStatus() : null;
  if (status !== IN_TRANSACTION) {
    throw new OutboxTransactionRequiredError(
      `outbox enqueue는 BEGIN 뒤의 정상 트랜잭션 안에서 호출한다(연결 상태: ${status ?? "알 수 없음"})`);
  }
}

/**
 * 호출자의 트랜잭션 안에서 이벤트를 기록한다.
 *
 * @param {import("pg").PoolClient} client BEGIN을 실행한 연결
 * @param {{ topic: string, aggregateId?: string|null, payload?: object, delayMs?: number }} event
 *   delayMs: 이 시간이 지난 뒤 전달한다(기본 0, 최대 30일)
 * @returns {Promise<{ id: string }|null>} 기록한 행의 id. MEMENTO_OUTBOX=off이면 null
 */
export async function enqueue(client, event) {
  assertPoolClient(client);
  const row = normalizeOutboxEvent(event);
  assertInTransaction(client);
  if (!outboxEnabled()) return null;

  const result = await client.query(INSERT_SQL, [row.topic, row.aggregateId, row.payloadJson, row.delayMs]);
  outboxEnqueuedTotal.inc({ topic: topicLabel(row.topic) });
  return { id: String(result.rows[0].id) };
}

/**
 * 업무 변경이 없는 이벤트를 짧은 독립 트랜잭션으로 기록한다.
 *
 * @param {import("pg").Pool} pool
 * @param {{ topic: string, aggregateId?: string|null, payload?: object, delayMs?: number }} event
 * @returns {Promise<{ id: string }|null>}
 */
export async function enqueueStandalone(pool, event) {
  normalizeOutboxEvent(event);
  if (!outboxEnabled()) return null;
  return withTransaction(pool, (client) => enqueue(client, event));
}
