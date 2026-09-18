/**
 * Primary 풀 백그라운드 게이트
 *
 * 작성자: 최진호
 * 작성일: 2026-09-18
 *
 * 스케줄러·PollingWorker 같은 백그라운드 작업이 Primary 풀 연결을 한꺼번에 점유하면
 * remember/recall 요청과 /health 가 'timeout exceeded when trying to connect' 로 굶는다.
 * 이 모듈은 백그라운드 경로의 연결 획득을 FIFO 대기 큐 뒤에 세워, 동시에 잡을 수 있는
 * 연결 수를 DB_BACKGROUND_MAX_CONNECTIONS 로 묶는다. 슬롯이 비면 큐 선두가 깨어나며
 * 대기 시간에 상한은 없다. 남는 연결은 항상 요청 경로 몫으로 남는다.
 *
 * 레인 판별은 AsyncLocalStorage 로 한다. runInBackground() 안에서 시작된 비동기 체인만
 * 게이트를 타고, 요청 경로는 풀을 직접 쓴다. 백그라운드 코드가 연결 하나를 쥔 채 같은 풀에서
 * 또 하나를 요구하면 슬롯 교착이 생기므로, 백그라운드 경로는 그런 중첩 획득을 하지 않는다.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { logWarn } from "../logger.js";

const laneStorage = new AsyncLocalStorage();

/** 이 시간 넘게 슬롯을 기다리면 경고 한 줄을 남긴다(실패시키지 않는다). */
const SLOW_WAIT_WARN_MS = 15_000;

export class BackgroundGate {
  /**
   * @param {{ capacity: number, slowWaitWarnMs?: number, onSlowWait?: Function }} opts
   */
  constructor({ capacity, slowWaitWarnMs = SLOW_WAIT_WARN_MS, onSlowWait = null } = {}) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error(`BackgroundGate capacity must be a positive integer, got ${capacity}`);
    }
    this.capacity        = capacity;
    this.active          = 0;
    this._queue          = [];
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
    if (this.active < this.capacity && this._queue.length === 0) {
      this.active += 1;
      return Promise.resolve(this._makeRelease());
    }

    return new Promise(resolve => {
      const entry = { laneName, resolve, enqueuedAt: Date.now(), timer: null };
      entry.timer = setTimeout(() => {
        const waitedMs = Date.now() - entry.enqueuedAt;
        const message  = `[PoolGate] ${laneName} waited ${waitedMs}ms for a background slot (active=${this.active}/${this.capacity}, waiting=${this._queue.length})`;
        if (this._onSlowWait) this._onSlowWait(message);
        else logWarn(message);
      }, this._slowWaitWarnMs);
      entry.timer.unref?.();
      this._queue.push(entry);
    });
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
      clearTimeout(entry.timer);
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
    if (!lane) return rawConnect(cb);

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
