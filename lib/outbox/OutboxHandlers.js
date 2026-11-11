/**
 * outbox 처리기 등록부
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 소비자는 topic 하나에 처리기 하나를 등록한다. 작업자는 등록된 topic의 이벤트만 점유하므로,
 * 처리기를 모르는 프로세스(예: 이전 판을 돌리는 다른 인스턴스)는 그 이벤트를 건드리지 않는다.
 *
 * 처리기 계약
 *   handler(event, { signal }) → Promise
 *   event: { id, topic, aggregateId, payload, attempts, createdAt, idempotencyKey }
 *   - 같은 이벤트가 두 번 이상 전달될 수 있다(임대 만료 후 재점유, 처리기 시간 초과).
 *     소비자는 idempotencyKey("topic:id")로 멱등을 보장한다.
 *   - 예외를 던지면 재시도한다. OutboxPermanentError를 던지면 재시도 없이 dead-letter로 남긴다.
 *   - signal은 시간 초과 시 중단된다. 오래 걸리는 처리기는 signal을 살핀다.
 *
 * 같은 topic의 두 번째 등록(options.onDuplicate)
 *   - "error"(기본): 거부한다(OUTBOX_DUPLICATE_TOPIC).
 *   - "replace": 새 처리기로 바꾼다. 그 등록을 해제하면 앞 등록이 돌아온다.
 *   - "chain": 앞 처리기를 부른 뒤 새 처리기를 같은 이벤트와 ctx로 부른다. 앞 처리기가 실패하면 뒤 처리기를
 *     부르지 않고 실패를 전하며, 이벤트 전체가 재시도된다. 그래서 묶인 처리기는 모두 idempotencyKey로 멱등이어야 한다.
 *     재시도 상한은 두 등록 중 작은 값이다. 그 등록을 해제하면 앞 등록이 돌아온다.
 *   topic에 처리기가 없으면 세 값 모두 단순 등록이다. 해제는 등록한 순서의 역순으로 한다.
 */

/** topic 형식: 소문자로 시작하는 조각을 점으로 잇는다. migration-052의 CHECK와 같다. */
export const TOPIC_PATTERN    = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
export const TOPIC_MAX_LENGTH = 64;

/** 처리기별 재시도 상한 재정의의 허용 범위. MEMENTO_OUTBOX_MAX_ATTEMPTS와 같다. */
const MAX_ATTEMPTS_RANGE = Object.freeze({ min: 1, max: 100 });

/** 등록 오류. code로 원인을 구분한다. */
export class OutboxHandlerRegistrationError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "OutboxHandlerRegistrationError";
    this.code = code;
  }
}

/** 처리기가 재시도해도 성공할 수 없다고 판정할 때 던지는 오류. 이벤트는 곧바로 dead-letter가 된다. */
export class OutboxPermanentError extends Error {
  /**
   * @param {string} message
   * @param {{ cause?: unknown }} [options]
   */
  constructor(message, options) {
    super(message, options);
    this.name = "OutboxPermanentError";
  }
}

/** 같은 topic 두 번째 등록의 처리 방식 */
const ON_DUPLICATE = Object.freeze(["error", "replace", "chain"]);

/** topic → { topic, handler, maxAttempts } */
const handlers = new Map();

/**
 * topic 형식 검사.
 *
 * @param {unknown} topic
 * @returns {boolean}
 */
export function isValidTopic(topic) {
  return typeof topic === "string" && topic.length <= TOPIC_MAX_LENGTH && TOPIC_PATTERN.test(topic);
}

/**
 * 처리기별 재시도 상한을 검사한다. 지정하지 않으면 null(전역 값 사용)이다.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
function checkedMaxAttempts(value) {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || value < MAX_ATTEMPTS_RANGE.min || value > MAX_ATTEMPTS_RANGE.max) {
    throw new OutboxHandlerRegistrationError("OUTBOX_INVALID_MAX_ATTEMPTS",
      `maxAttempts는 ${MAX_ATTEMPTS_RANGE.min} 이상 ${MAX_ATTEMPTS_RANGE.max} 이하의 정수여야 한다`);
  }
  return value;
}

/**
 * topic의 처리기를 등록한다.
 *
 * @param {string}   topic
 * @param {(event: object, ctx: { signal: AbortSignal }) => Promise<unknown>} handler
 * @param {{ maxAttempts?: number, onDuplicate?: "error"|"replace"|"chain" }} [options]
 *        maxAttempts: 이 topic의 점유 횟수 상한. onDuplicate: 같은 topic에 처리기가 있을 때의 처리(위 설명)
 * @returns {() => void} 이 등록을 해제하는 함수
 */
export function registerOutboxHandler(topic, handler, { maxAttempts, onDuplicate = "error" } = {}) {
  if (!isValidTopic(topic)) {
    throw new OutboxHandlerRegistrationError("OUTBOX_INVALID_TOPIC", `outbox topic 형식이 아니다: ${String(topic).slice(0, 80)}`);
  }
  if (typeof handler !== "function") {
    throw new OutboxHandlerRegistrationError("OUTBOX_INVALID_HANDLER", `outbox 처리기는 함수여야 한다: ${topic}`);
  }
  if (!ON_DUPLICATE.includes(onDuplicate)) {
    throw new OutboxHandlerRegistrationError("OUTBOX_INVALID_ON_DUPLICATE", `onDuplicate는 ${ON_DUPLICATE.join(", ")} 중 하나다`);
  }
  const limit    = checkedMaxAttempts(maxAttempts);
  const previous = handlers.get(topic) ?? null;
  if (previous && onDuplicate === "error") {
    throw new OutboxHandlerRegistrationError("OUTBOX_DUPLICATE_TOPIC", `이미 처리기가 등록된 topic이다: ${topic}`);
  }
  const entry = Object.freeze(previous && onDuplicate === "chain"
    ? { topic, handler: chainHandlers(previous.handler, handler), maxAttempts: smallerLimit(previous.maxAttempts, limit) }
    : { topic, handler, maxAttempts: limit });
  handlers.set(topic, entry);
  return () => {
    if (handlers.get(topic) !== entry) return;
    if (previous) handlers.set(topic, previous);
    else handlers.delete(topic);
  };
}

/** 앞 처리기가 성공한 뒤 뒤 처리기를 부르는 처리기 */
function chainHandlers(first, second) {
  return async (event, ctx) => {
    await first(event, ctx);
    return second(event, ctx);
  };
}

/** 두 재시도 상한 중 작은 값. null은 전역 값이다 */
function smallerLimit(a, b) {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

/**
 * topic의 등록 항목. 없으면 null.
 *
 * @param {string} topic
 * @returns {{ topic: string, handler: Function, maxAttempts: number|null }|null}
 */
export function getOutboxHandler(topic) {
  return handlers.get(topic) ?? null;
}

/**
 * 등록된 topic 목록(이름순).
 *
 * @returns {string[]}
 */
export function listOutboxTopics() {
  return [...handlers.keys()].sort();
}

/** 시험용 초기화. */
export function _resetOutboxHandlers() {
  handlers.clear();
}
