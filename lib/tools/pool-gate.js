/**
 * Primary 풀 백그라운드 게이트
 *
 * 작성자: 최진호
 * 작성일: 2026-09-18
 * 수정일: 2026-09-19 (대기 상한·close·ending 통과 추가)
 *
 * 스케줄러·PollingWorker 같은 백그라운드 작업이 Primary 풀 연결을 한꺼번에 점유하면
 * remember/recall 요청과 /health 가 'timeout exceeded when trying to connect' 로 굶는다.
 * 이 모듈은 백그라운드 경로의 연결 획득을 FIFO 대기 큐 뒤에 세워, 동시에 잡을 수 있는
 * 연결 수를 DB_BACKGROUND_MAX_CONNECTIONS 로 묶는다. 슬롯이 비면 큐 선두가 깨어나며
 * 남는 연결은 항상 요청 경로 몫으로 남는다.
 *
 * 대기에는 maxWaitMs 상한이 있다. 백그라운드 코드가 연결 하나를 쥔 채 같은 풀에서 또 하나를
 * 요구하는 중첩 획득이 capacity 만큼 겹치면 슬롯 교착이 되는데, 상한이 없으면 그 교착이
 * 영구화되고 pool.end() 까지 막는다. 상한을 넘긴 대기는 실패로 돌려 다음 회차에 재시도하게 한다.
 *
 * 레인 판별은 AsyncLocalStorage 로 한다. runInBackground() 안에서 시작된 비동기 체인만
 * 게이트를 타고, 요청 경로는 풀을 직접 쓴다.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { logWarn } from "../logger.js";

const laneStorage = new AsyncLocalStorage();

/** 이 시간 넘게 슬롯을 기다리면 경고 한 줄을 남긴다(실패시키지 않는다). */
const SLOW_WAIT_WARN_MS = 15_000;

/** 대기 상한 기본값. 넘기면 background_slot_timeout 으로 실패한다. */
const MAX_WAIT_MS = 120_000;

export class BackgroundGateTimeoutError extends Error {
  constructor(laneName, waitedMs, gate) {
    super(`[PoolGate] ${laneName} gave up after ${waitedMs}ms waiting for a background slot (active=${gate.active}/${gate.capacity}, waiting=${gate.waiting})`);
    this.name = "BackgroundGateTimeoutError";
    this.code = "background_slot_timeout";
  }
}

export class BackgroundGateClosedError extends Error {
  constructor(laneName) {
    super(`[PoolGate] ${laneName} cannot acquire a background slot: gate is closed`);
    this.name = "BackgroundGateClosedError";
    this.code = "background_gate_closed";
  }
}

export class BackgroundGate {
  /**
   * @param {{ capacity: number, maxWaitMs?: number, slowWaitWarnMs?: number, onSlowWait?: Function }} opts
   */
  constructor({ capacity, maxWaitMs = MAX_WAIT_MS, slowWaitWarnMs = SLOW_WAIT_WARN_MS, onSlowWait = null } = {}) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error(`BackgroundGate capacity must be a positive integer, got ${capacity}`);
    }
    if (!Number.isFinite(maxWaitMs) || maxWaitMs <= 0) {
      throw new Error(`BackgroundGate maxWaitMs must be a positive number, got ${maxWaitMs}`);
    }
    this.capacity        = capacity;
    this.active          = 0;
    this.closed          = false;
    this._queue          = [];
    this._maxWaitMs      = maxWaitMs;
    this._slowWaitWarnMs = slowWaitWarnMs;
    this._onSlowWait     = onSlowWait;
  }

  get waiting() {
    return this._queue.length;
  }

  /**
   * 슬롯 하나를 받을 때까지 FIFO 로 기다린다.
   *
   * @param {string} laneName 대기 주체 이름(로그용)
   * @returns {Promise<() => void>} 슬롯 반납 함수(중복 호출 안전)
   */
  acquire(laneName = "background") {
    if (this.closed) return Promise.reject(new BackgroundGateClosedError(laneName));

    if (this.active < this.capacity && this._queue.length === 0) {
      this.active += 1;
      return Promise.resolve(this._makeRelease());
    }

    return new Promise((resolve, reject) => {
      const entry = { laneName, resolve, reject, enqueuedAt: Date.now(), warnTimer: null, deadlineTimer: null };

      entry.warnTimer = setTimeout(() => {
        const waitedMs = Date.now() - entry.enqueuedAt;
        const message  = `[PoolGate] ${laneName} waited ${waitedMs}ms for a background slot (active=${this.active}/${this.capacity}, waiting=${this._queue.length})`;
        if (this._onSlowWait) this._onSlowWait(message);
        else logWarn(message);
      }, this._slowWaitWarnMs);
      entry.warnTimer.unref?.();

      entry.deadlineTimer = setTimeout(() => {
        this._dequeue(entry);
        entry.reject(new BackgroundGateTimeoutError(laneName, Date.now() - entry.enqueuedAt, this));
      }, this._maxWaitMs);
      entry.deadlineTimer.unref?.();

      this._queue.push(entry);
    });
  }

  /** 대기 중인 요청을 모두 실패시키고 새 획득을 거부한다. pool.end() 직전에 부른다. */
  close() {
    this.closed = true;
    const pending = this._queue.splice(0);
    for (const entry of pending) {
      this._clearTimers(entry);
      entry.reject(new BackgroundGateClosedError(entry.laneName));
    }
  }

  /** close() 뒤 풀이 다시 만들어질 때 게이트를 재개한다. */
  open() {
    this.closed = false;
  }

  _dequeue(entry) {
    const idx = this._queue.indexOf(entry);
    if (idx >= 0) this._queue.splice(idx, 1);
    this._clearTimers(entry);
  }

  _clearTimers(entry) {
    clearTimeout(entry.warnTimer);
    clearTimeout(entry.deadlineTimer);
  }

  _makeRelease() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this._pulse();
    };
  }

  _pulse() {
    while (this.active < this.capacity && this._queue.length > 0) {
      const entry = this._queue.shift();
      this._clearTimers(entry);
      this.active += 1;
      entry.resolve(this._makeRelease());
    }
  }
}

/**
 * fn 을 백그라운드 레인에서 실행한다. 안에서 시작된 모든 비동기 체인이 게이트를 탄다.
 *
 * @template T
 * @param {string} name 레인 이름(로그·통계용)
 * @param {() => T} fn
 * @returns {T}
 */
export function runInBackground(name, fn) {
  return laneStorage.run({ name }, fn);
}

/** 현재 비동기 체인이 백그라운드 레인이면 그 레인 정보를, 아니면 null 을 돌려준다. */
export function currentLane() {
  return laneStorage.getStore() ?? null;
}

/**
 * pg Pool 인스턴스의 connect 를 게이트 뒤로 옮긴다.
 * pg-pool 의 query() 는 내부적으로 this.connect() 를 부르므로 connect 하나만 감싸면
 * pool.query / pool.connect 양쪽이 모두 게이트를 탄다.
 *
 * @param {import("pg").Pool} pool
 * @param {BackgroundGate} gate
 * @returns {import("pg").Pool} 같은 인스턴스
 */
export function gatePool(pool, gate) {
  const rawConnect = pool.connect.bind(pool);

  const gatedConnect = async (laneName) => {
    const releaseSlot = await gate.acquire(laneName);
    let client;
    try {
      client = await rawConnect();
    } catch (err) {
      releaseSlot();
      throw err;
    }
    const rawRelease = client.release;
    client.release   = (err) => {
      client.release = rawRelease;
      try {
        return rawRelease.call(client, err);
      } finally {
        releaseSlot();
      }
    };
    return client;
  };

  pool.connect = function connect(cb) {
    const lane = currentLane();
    /** 종료 중인 풀은 pg-pool 이 즉시 거부하므로 슬롯을 소모하지 않고 그대로 넘긴다. */
    if (!lane || pool.ending) return rawConnect(cb);

    const pending = gatedConnect(lane.name);
    if (typeof cb !== "function") return pending;

    pending.then(
      client => cb(undefined, client, client.release),
      err    => cb(err, undefined, () => {})
    );
    return undefined;
  };

  return pool;
}
