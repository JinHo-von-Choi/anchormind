/**
 * outbox 작업자
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 회차마다 등록된 topic의 대기 행을 묶음으로 점유하고(OutboxStore.claim), 점유 순서대로 하나씩
 * 처리기에 넘긴 뒤 완료나 실패를 기록한다. 처리기를 실행하는 동안 트랜잭션이나 행 잠금을 쥐지 않는다.
 *
 * 전달 보장
 *   - 최소 한 번. 같은 이벤트가 다시 전달되는 경우: 작업자가 처리 중에 죽어 임대가 끝난 뒤 재점유, 처리기
 *     시간 초과 뒤 재시도(시간 초과한 처리기는 계속 돌 수 있어 재시도와 겹칠 수 있다), 완료나 실패 기록이
 *     임대 안에 반영되지 못한 경우(기록 질의도 백그라운드 풀 관문을 거치므로 풀이 포화되면
 *     DB_BACKGROUND_WAIT_MAX_MS까지 기다릴 수 있다. lease_lost로 센다). 소비자는 멱등 키 "topic:id"로
 *     중복을 흡수한다.
 *   - 임대가 유효한 동안 같은 이벤트를 두 작업자가 동시에 처리하지 않는다(SKIP LOCKED 점유와 미래의
 *     available_at). 작업자는 남은 임대가 처리기 시간 상한과 여유보다 짧으면 다음 이벤트를 시작하지
 *     않고 나머지 점유를 반납한다.
 *
 * 순서
 *   - 한 회차의 묶음은 (점유 전 available_at, id) 순으로 하나씩 처리한다.
 *   - 그 밖의 순서는 보장하지 않는다. 묶음 사이, 작업자 사이, 같은 aggregate의 이벤트 사이에 순서가
 *     없고, 실패한 이벤트는 나중 이벤트보다 늦게 전달될 수 있다. 순서가 필요한 소비자는 자기 기록
 *     시점에 순번을 정한다.
 *
 * 재시도: 점유 횟수 attempts가 상한(처리기 등록의 maxAttempts, 없으면 MEMENTO_OUTBOX_MAX_ATTEMPTS)에
 * 이르기 전의 실패는 지수 간격(기준 1초, 실패마다 두 배, 상한 30분, 간격의 절반에서 전체 사이 무작위)
 * 뒤에 다시 점유한다. 상한에 이른 실패와 OutboxPermanentError는 dead-letter로 남긴다. 점유할 때
 * attempts를 늘리므로 처리 중 프로세스를 죽게 만드는 이벤트도 상한에서 멈춘다.
 *
 * 정리와 통계: 같은 회차 앞에서 간격이 지났으면 보존 기간이 지난 완료 행을 묶음 단위로 지우고(회차
 * 상한 있음), 이 프로세스에 처리기가 없는 topic의 대기 행 중 전달 예정 시각이 MEMENTO_OUTBOX_UNHANDLED_DAYS
 * 넘게 지난 행을 dead-letter(no_handler)로 옮기며, 대기와 dead-letter 건수와 지연을 게이지와 스케줄러
 * 기록에 반영한다.
 */

import crypto from "node:crypto";

import {
  outboxEnabled, outboxWorkerEnabled, outboxMaxAttempts, outboxRetentionDays, outboxUnhandledDays
} from "../config.js";
import { logWarn, logError }    from "../logger.js";
import { getPrimaryPool }       from "../tools/db.js";
import { getSchedulerRegistry } from "../scheduler-registry.js";
import { PollingWorker }        from "../memory/workers/PollingWorker.js";
import { idempotencyKey }       from "./Outbox.js";
import { OutboxStore }          from "./OutboxStore.js";
import { getOutboxHandler, listOutboxTopics, OutboxPermanentError } from "./OutboxHandlers.js";
import {
  outboxProcessedTotal, outboxFailedTotal, outboxDeadLetterTotal, outboxLeaseLostTotal,
  outboxCleanedTotal, outboxUnhandledTotal, outboxDeliverySeconds, setOutboxGauges, topicLabel
} from "./outbox-metrics.js";

/** 작업자 동작 값. 생성자의 settings로 바꿀 수 있다(시험). */
export const OUTBOX_WORKER_DEFAULTS = Object.freeze({
  pollIntervalMs   : 1_000,
  batchSize        : 50,
  leaseMs          : 60_000,
  handlerTimeoutMs : 15_000,
  settleMarginMs   : 5_000,
  backoffBaseMs    : 1_000,
  backoffMaxMs     : 1_800_000,
  cleanupIntervalMs: 300_000,
  cleanupChunk     : 500,
  cleanupMaxPerRun : 5_000,
  statsIntervalMs  : 15_000
});

const ERROR_SUMMARY_MAX = 500;

/** 처리기가 시간 상한을 넘겼다. */
export class OutboxHandlerTimeoutError extends Error {
  /** @param {number} timeoutMs */
  constructor(timeoutMs) {
    super(`outbox 처리기가 ${timeoutMs}ms 안에 끝나지 않았다`);
    this.name = "OutboxHandlerTimeoutError";
  }
}

/**
 * 재시도 간격. 지수 간격 base * 2^(attempts-1)을 max로 자르고, 그 절반에서 전체 사이 값을 고른다.
 *
 * @param {number} attempts 지금까지의 점유 횟수(이번 실패 포함)
 * @param {{ baseMs: number, maxMs: number }} limits
 * @param {() => number} [random] [0, 1) 난수
 * @returns {number} 밀리초
 */
export function computeBackoffMs(attempts, { baseMs, maxMs }, random = Math.random) {
  const n       = Number.isInteger(attempts) && attempts > 0 ? attempts : 1;
  const ceiling = Math.min(maxMs, baseMs * 2 ** Math.min(n - 1, 52));
  return Math.floor(ceiling / 2 + random() * (ceiling / 2));
}

/**
 * 실패한 이벤트를 재시도할지 dead-letter로 남길지 정한다.
 *
 * @param {{ attempts: number, maxAttempts: number, permanent: boolean }} args
 * @returns {"retry"|"dead"}
 */
export function decideFailure({ attempts, maxAttempts, permanent }) {
  return permanent || attempts >= maxAttempts ? "dead" : "retry";
}

/**
 * 남은 임대 안에 이벤트 하나를 처리하고 기록할 수 있는지 판정한다.
 *
 * @param {{ now: number, leaseDeadline: number, handlerTimeoutMs: number, marginMs: number }} args
 * @returns {boolean}
 */
export function canStartNext({ now, leaseDeadline, handlerTimeoutMs, marginMs }) {
  return leaseDeadline - now >= handlerTimeoutMs + marginMs;
}

/**
 * last_error에 남길 한 줄. "이름: 메시지"를 500자로 자른다.
 *
 * @param {unknown} err
 * @returns {string}
 */
export function errorSummary(err) {
  const name    = err instanceof Error ? err.name : "Error";
  const message = err instanceof Error ? err.message : String(err);
  return `${name}: ${message}`.slice(0, ERROR_SUMMARY_MAX);
}

/**
 * 처리기를 시간 상한 안에서 실행한다. 넘기면 signal을 중단하고 OutboxHandlerTimeoutError를 던진다.
 *
 * @param {Function} handler
 * @param {object} event
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 */
async function runHandler(handler, event, timeoutMs) {
  const controller = new AbortController();
  let   timer      = null;
  const timeout    = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new OutboxHandlerTimeoutError(timeoutMs));
    }, timeoutMs);
  });
  try {
    await Promise.race([Promise.resolve().then(() => handler(event, { signal: controller.signal })), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export class OutboxWorker extends PollingWorker {
  /**
   * @param {object} [deps]
   * @param {OutboxStore}  [deps.store]             기본: 주 풀의 OutboxStore
   * @param {() => number} [deps.clock]             밀리초 시계
   * @param {() => number} [deps.random]            [0, 1) 난수
   * @param {import("../scheduler-registry.js").SchedulerRegistry} [deps.schedulerRegistry]
   * @param {Partial<typeof OUTBOX_WORKER_DEFAULTS>} [deps.settings]
   */
  constructor({ store = null, clock = Date.now, random = Math.random, schedulerRegistry = null, settings = {} } = {}) {
    const merged = { ...OUTBOX_WORKER_DEFAULTS, ...settings };
    super({ name: "OutboxWorker", intervalMs: merged.pollIntervalMs, idleOnlyDelay: true });
    this.settings      = merged;
    this.clock         = clock;
    this.random        = random;
    this._store        = store;
    this._registry     = schedulerRegistry;
    this._nextCleanup  = 0;
    this._nextStats    = 0;
    this._lastStats    = null;
    this._totals       = { processed: 0, failed: 0, deadLettered: 0, leaseLost: 0, released: 0, cleaned: 0, unhandled: 0 };
  }

  /** @returns {OutboxStore} */
  get store() {
    if (!this._store) this._store = new OutboxStore(getPrimaryPool());
    return this._store;
  }

  /** @returns {import("../scheduler-registry.js").SchedulerRegistry} */
  get schedulerRegistry() {
    return this._registry ?? getSchedulerRegistry();
  }

  /** 두 스위치가 모두 켜져 있을 때만 기동한다. */
  _shouldStart() {
    return outboxEnabled() && outboxWorkerEnabled();
  }

  /**
   * 한 회차: 정리와 통계(간격이 지났을 때), 점유와 전달.
   *
   * @returns {Promise<number>} 완료나 실패를 기록한 이벤트 수
   */
  async _processBatch() {
    await this._housekeeping();

    const topics = listOutboxTopics();
    if (topics.length === 0) return 0;

    const { batchSize, leaseMs } = this.settings;
    const token         = crypto.randomUUID();
    const leaseDeadline = this.clock() + leaseMs;
    const events        = await this.store.claim({ topics, limit: batchSize, leaseMs, token });
    return this._deliverAll(events, token, leaseDeadline);
  }

  /**
   * 점유한 이벤트를 차례로 전달한다. 정지 요청, 임대 부족, 완료나 실패 기록의 오류로 멈추면 아직 시작하지
   * 않은 점유를 반납한다. 기록 중 오류가 난 이벤트 자신은 결과를 모르므로 반납하지 않고 임대 만료 뒤 다시
   * 점유된다(그 점유는 attempts에 이미 세었다). 오류는 반납 뒤 다시 던져 작업자가 물러서게 한다.
   *
   * @param {Array<object>} events
   * @param {string} token
   * @param {number} leaseDeadline 이 작업자 시계 기준 임대 만료 시각(점유 문장을 보내기 전 시각 + leaseMs)
   * @returns {Promise<number>}
   */
  async _deliverAll(events, token, leaseDeadline) {
    const { handlerTimeoutMs, settleMarginMs } = this.settings;
    let handled = 0;
    let next    = 0;
    try {
      while (next < events.length) {
        const fits = canStartNext({ now: this.clock(), leaseDeadline, handlerTimeoutMs, marginMs: settleMarginMs });
        if (!this.running || !fits) break;
        const event = events[next++];
        const entry = getOutboxHandler(event.topic);
        if (!entry) {
          await this._release([event], token);
          continue;
        }
        await this._deliver(entry, event, token);
        handled++;
      }
    } finally {
      await this._releaseRest(events.slice(next), token);
    }
    return handled;
  }

  /**
   * 처리하지 않은 점유를 반납한다.
   *
   * @param {Array<object>} events
   * @param {string} token
   */
  async _release(events, token) {
    if (events.length === 0) return;
    const released = await this.store.release(events.map(e => e.id), token);
    this._totals.released += released;
  }

  /**
   * 회차 끝에 남은 점유를 반납한다. 반납이 실패하면 기록만 하고(행은 임대 만료 뒤 다시 점유된다) 회차의
   * 원래 결과나 오류를 가리지 않는다.
   *
   * @param {Array<object>} events
   * @param {string} token
   */
  async _releaseRest(events, token) {
    try {
      await this._release(events, token);
    } catch (err) {
      logWarn(`[OutboxWorker] release of ${events.length} claimed event(s) failed, they wait for lease expiry: ${err.message}`);
      this.schedulerRegistry.recordFailure("outbox", err);
    }
  }

  /**
   * 이벤트 하나를 처리기에 넘기고 결과를 기록한다.
   *
   * @param {{ handler: Function, maxAttempts: number|null }} entry
   * @param {object} event
   * @param {string} token
   */
  async _deliver(entry, event, token) {
    const delivered = Object.freeze({
      id            : event.id,
      topic         : event.topic,
      aggregateId   : event.aggregateId,
      payload       : event.payload,
      attempts      : event.attempts,
      createdAt     : event.createdAt,
      idempotencyKey: idempotencyKey(event)
    });
    try {
      await runHandler(entry.handler, delivered, this.settings.handlerTimeoutMs);
    } catch (err) {
      await this._recordFailure(entry, event, token, err);
      return;
    }
    const { applied, deliverySeconds } = await this.store.complete(event.id, token, event.dueAt ?? null);
    if (!applied) {
      this._noteLeaseLost(event, "complete");
      return;
    }
    const label = topicLabel(event.topic);
    outboxProcessedTotal.inc({ topic: label });
    if (Number.isFinite(deliverySeconds)) outboxDeliverySeconds.observe({ topic: label }, deliverySeconds);
    this._totals.processed++;
  }

  /**
   * 처리기 실패를 재시도 예약이나 dead-letter로 기록한다.
   *
   * @param {{ maxAttempts: number|null }} entry
   * @param {object} event
   * @param {string} token
   * @param {unknown} err
   */
  async _recordFailure(entry, event, token, err) {
    const maxAttempts = entry.maxAttempts ?? outboxMaxAttempts();
    const verdict     = decideFailure({ attempts: event.attempts, maxAttempts, permanent: err instanceof OutboxPermanentError });
    const dead        = verdict === "dead";
    const summary     = errorSummary(err);
    const retryDelayMs = dead ? 0 : computeBackoffMs(event.attempts,
      { baseMs: this.settings.backoffBaseMs, maxMs: this.settings.backoffMaxMs }, this.random);

    const applied = await this.store.fail(event.id, token, { retryDelayMs, error: summary, dead });
    if (!applied) {
      this._noteLeaseLost(event, "fail");
      return;
    }
    const label = topicLabel(event.topic);
    if (dead) {
      outboxDeadLetterTotal.inc({ topic: label });
      this._totals.deadLettered++;
      logError(`[OutboxWorker] dead-letter topic=${event.topic} id=${event.id} attempts=${event.attempts}/${maxAttempts}: ${summary}`);
      return;
    }
    outboxFailedTotal.inc({ topic: label });
    this._totals.failed++;
    logWarn(`[OutboxWorker] retry topic=${event.topic} id=${event.id} attempts=${event.attempts}/${maxAttempts} in ${retryDelayMs}ms: ${summary}`);
  }

  /**
   * 임대를 잃어 기록이 반영되지 않은 경우를 센다.
   *
   * @param {object} event
   * @param {string} op
   */
  _noteLeaseLost(event, op) {
    outboxLeaseLostTotal.inc();
    this._totals.leaseLost++;
    logWarn(`[OutboxWorker] lease lost before ${op}: topic=${event.topic} id=${event.id} attempts=${event.attempts}`);
  }

  /**
   * 간격이 지났으면 정리와 통계를 실행한다. 실패는 기록하고 전달을 막지 않는다.
   */
  async _housekeeping() {
    const now = this.clock();
    try {
      if (now >= this._nextCleanup) {
        this._nextCleanup = now + this.settings.cleanupIntervalMs;
        await this._cleanup();
        await this._deadLetterUnhandled();
      }
      if (now >= this._nextStats) {
        this._nextStats = now + this.settings.statsIntervalMs;
        await this._refreshStats();
      }
    } catch (err) {
      logWarn(`[OutboxWorker] housekeeping failed: ${err.message}`);
      this.schedulerRegistry.recordFailure("outbox", err);
    }
  }

  /** 보존 기간이 지난 완료 행을 묶음 단위로, 회차 상한까지 지운다. */
  async _cleanup() {
    const { cleanupChunk, cleanupMaxPerRun } = this.settings;
    const retentionDays = outboxRetentionDays();
    let   deleted       = 0;
    while (deleted < cleanupMaxPerRun) {
      const limit = Math.min(cleanupChunk, cleanupMaxPerRun - deleted);
      const n     = await this.store.cleanup({ retentionDays, limit });
      deleted += n;
      if (n < limit) break;
    }
    if (deleted > 0) outboxCleanedTotal.inc(deleted);
    this._totals.cleaned += deleted;
  }

  /**
   * 이 프로세스에 처리기가 없는 topic의 오래된 대기 행을 dead-letter(no_handler)로 옮긴다. 이런 행은 어느
   * 작업자도 점유하지 않으면서 매 점유 질의가 훑으므로, 묶음 단위로 회차 상한까지 옮긴다.
   */
  async _deadLetterUnhandled() {
    const { cleanupChunk, cleanupMaxPerRun } = this.settings;
    const topics        = listOutboxTopics();
    const olderThanDays = outboxUnhandledDays();
    let   moved         = 0;
    while (moved < cleanupMaxPerRun) {
      const limit = Math.min(cleanupChunk, cleanupMaxPerRun - moved);
      const n     = await this.store.deadLetterUnhandled({ topics, olderThanDays, limit });
      moved += n;
      if (n < limit) break;
    }
    if (moved > 0) {
      outboxUnhandledTotal.inc(moved);
      logWarn(`[OutboxWorker] moved ${moved} pending event(s) without a handler to dead-letter (no_handler)`);
    }
    this._totals.unhandled += moved;
  }

  /** 게이지, 스냅숏, 스케줄러 기록을 갱신한다. */
  async _refreshStats() {
    const stats     = await this.store.stats();
    this._lastStats = { ...stats, at: new Date(this.clock()).toISOString() };
    setOutboxGauges(stats, this.clock());
    this.schedulerRegistry.recordSuccess("outbox", { ...stats, ...this._totals });
  }

  /**
   * 상태 조회용 스냅숏. 마지막 통계와 이 프로세스의 누계.
   *
   * @returns {{ running: boolean, pending: number|null, dead: number|null, lagSeconds: number|null, statsAt: string|null, totals: object }}
   */
  snapshot() {
    return {
      running   : this.running,
      pending   : this._lastStats?.pending ?? null,
      dead      : this._lastStats?.dead ?? null,
      lagSeconds: this._lastStats?.lagSeconds ?? null,
      statsAt   : this._lastStats?.at ?? null,
      totals    : { ...this._totals }
    };
  }
}

/** 싱글톤 */
let workerInstance = null;

/**
 * 프로세스 전역 outbox 작업자.
 *
 * @returns {OutboxWorker}
 */
export function getOutboxWorker() {
  if (!workerInstance) workerInstance = new OutboxWorker();
  return workerInstance;
}
