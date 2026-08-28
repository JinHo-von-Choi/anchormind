/**
 * PollingWorker - 주기 폴링 워커 공통 수명주기
 *
 * 작성자: 최진호
 * 작성일: 2026-08-28
 *
 * 워커 네 종이 각자 폴링 간격, 백오프, 중복 기동 방지, in-flight 추적, 종료 시
 * 배수를 따로 구현하고 있었다. 같은 문제를 네 번 풀면 네 번 다르게 틀린다.
 * 실제로 어떤 워커는 대기 중 stop()에서 남은 대기 시간만큼 더 붙잡고,
 * 어떤 워커는 즉시 놓는다.
 *
 * 이 클래스가 수명주기를 담고, 하위 클래스는 `_processBatch()` 하나만 구현한다.
 * 배치가 실제로 일을 했는지는 반환값으로 알린다. 숫자면 처리 건수, 불리언이면
 * 처리 여부로 본다.
 *
 * 워커마다 다른 두 가지는 옵션으로 남긴다. 일을 처리한 직후 곧바로 다음 회차로
 * 갈지(`idleOnlyDelay`), 기동 전에 별도 조건을 볼지(`_shouldStart`).
 *
 * EventEmitter를 상속한다. 진행 상황을 밖으로 알리는 워커가 있고, 자바스크립트는
 * 다중 상속이 없어 기반이 이 능력을 함께 제공해야 한다.
 */

import { EventEmitter } from "node:events";

import { logInfo, logWarn, logError } from "../../logger.js";
import { registerWorker, unregisterWorker } from "./registry.js";

export class PollingWorker extends EventEmitter {
  /**
   * @param {Object}  options
   * @param {string}  options.name           로그에 쓰이는 워커 이름
   * @param {number}  options.intervalMs     할 일이 없을 때 다음 회차까지 간격
   * @param {number}  [options.backoffMs]    첫 실패 후 대기 시간
   * @param {number}  [options.backoffMaxMs] 백오프 상한
   * @param {boolean} [options.idleOnlyDelay] true면 일을 처리한 회차 뒤에는 쉬지 않는다
   */
  constructor({ name, intervalMs, backoffMs = 1000, backoffMaxMs = 60000, idleOnlyDelay = false }) {
    super();
    this.name           = name;
    this.intervalMs     = intervalMs;
    this.running        = false;
    this.timer          = null;
    this._backoff       = backoffMs;
    this._backoffBase   = backoffMs;
    this._backoffMax    = backoffMaxMs;
    this._idleOnlyDelay = idleOnlyDelay;
    this._processing    = false;
    this._drainResolve  = null;
  }

  /**
   * 기동 조건. 기본은 항상 참이며, 설정이 꺼져 있거나 의존 자원이 없으면
   * 하위 클래스가 거짓을 돌려 기동을 막는다.
   *
   * @returns {boolean}
   */
  _shouldStart() {
    return true;
  }

  /**
   * 기동 직후 한 번 실행되는 훅. in-flight 항목 복구 같은 일회성 작업을 둔다.
   *
   * @returns {Promise<void>}
   */
  async _onStart() {}

  /**
   * 한 회차의 일. 하위 클래스가 반드시 구현한다.
   *
   * @returns {Promise<number|boolean|void>} 처리 건수 또는 처리 여부
   */
  async _processBatch() {
    throw new Error(`${this.name}: _processBatch를 구현해야 한다`);
  }

  /**
   * 워커를 시작한다. 이미 돌고 있으면 무시한다.
   *
   * @returns {Promise<void>}
   */
  async start() {
    if (this.running) return;
    if (!this._shouldStart()) return;

    this.running = true;
    try {
      await this._onStart();
    } catch (err) {
      logWarn(`[${this.name}] 기동 훅 실패: ${err.message}`);
    }
    registerWorker(this);
    logInfo(`[${this.name}] Worker started`);
    this._poll();
  }

  /**
   * 워커를 멈추고 진행 중인 회차가 끝날 때까지 기다린다.
   *
   * 대기 중이었다면 타이머를 버리고 즉시 반환한다. 남은 대기 시간만큼
   * 종료를 붙잡을 이유가 없다.
   *
   * @returns {Promise<void>}
   */
  stop() {
    unregisterWorker(this);
    if (!this.running && !this._processing) return Promise.resolve();

    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this._processing) {
      logInfo(`[${this.name}] Waiting for in-flight batch to finish...`);
      return new Promise(resolve => { this._drainResolve = resolve; });
    }
    logInfo(`[${this.name}] Worker stopped (no in-flight work)`);
    return Promise.resolve();
  }

  /** 한 회차를 돌리고 다음 회차를 예약한다. */
  _poll() {
    if (!this.running) return;

    this._processing = true;
    let handled      = 0;

    this._processBatch()
      .then(result => {
        handled       = typeof result === "number" ? result : (result ? 1 : 0);
        this._backoff = this._backoffBase;
      })
      .catch(err => {
        logError(`[${this.name}] batch error`, err);
        this._backoff = Math.min(this._backoff * 2, this._backoffMax);
        logWarn(`[${this.name}] Backing off for ${this._backoff}ms`);
      })
      .finally(() => {
        this._processing = false;
        if (this._drainResolve) {
          logInfo(`[${this.name}] Worker stopped (in-flight batch finished)`);
          this._drainResolve();
          this._drainResolve = null;
          return;
        }
        if (!this.running) return;
        this.timer = setTimeout(() => this._poll(), this._nextDelay(handled));
      });
  }

  /**
   * 다음 회차까지의 대기 시간을 정한다.
   *
   * @param {number} handled 이번 회차 처리 건수
   * @returns {number} 밀리초
   */
  _nextDelay(handled) {
    if (this._backoff > this._backoffBase) return this._backoff;
    if (this._idleOnlyDelay && handled > 0) return 0;
    return this.intervalMs;
  }
}
