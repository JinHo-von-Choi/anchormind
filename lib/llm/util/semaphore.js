/**
 * Provider-level concurrency semaphore
 *
 * 작성자: 최진호
 * 작성일: 2026-04-24
 *
 * LLM provider별 동시 요청 수를 제한하여 HTTP 429 burst를 방지한다.
 * FIFO 대기 큐 + 타임아웃 기반의 순수 ES 모듈. 외부 의존성 없음.
 */

/** 모듈 수준 캐시: chainKey → Semaphore 인스턴스 */
const _cache = new Map();

/**
 * 세마포어 인스턴스를 생성한다.
 *
 * @param {{ key: string, limit: number, waitTimeoutMs: number }} opts
 * @returns {{ acquire: (timeoutMs?: number) => Promise<void>, release: () => void, active: () => number, waiting: () => number }}
 */
function createSemaphore({ _key, limit, waitTimeoutMs }) {
  let   _active  = 0;
  const _waiters = [];

  /**
   * 슬롯 하나를 점유한다.
   * limit 초과 시 waitTimeoutMs 안에 슬롯이 열리지 않으면 reject.
   *
   * @param {number} [timeoutMs]
   * @returns {Promise<void>}
   */
  function acquire(timeoutMs = waitTimeoutMs) {
    if (_active < limit) {
      _active++;
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = _waiters.findIndex(w => w.timer === timer);
        if (idx !== -1) _waiters.splice(idx, 1);
        reject(new Error("semaphore wait timeout"));
      }, timeoutMs);

      _waiters.push({ resolve, reject, timer });
    });
  }

  /**
   * 슬롯 하나를 반납하고, 대기열의 첫 번째 waiter를 깨운다 (FIFO).
   */
  function release() {
    if (_waiters.length > 0) {
      const waiter = _waiters.shift();
      clearTimeout(waiter.timer);
      // active count stays the same: 이전 holder → next waiter 전달
      waiter.resolve();
    } else {
      _active--;
    }
  }

  /** 현재 점유된 슬롯 수 (동기) */
  function active() {
    return _active;
  }

  /** 현재 대기 중인 waiter 수 (동기) */
  function waiting() {
    return _waiters.length;
  }

  return { acquire, release, active, waiting };
}

/**
 * key 기준으로 캐시된 세마포어 인스턴스를 반환한다.
 * 처음 요청 시에만 createSemaphore로 생성하고 이후에는 캐시를 재사용한다.
 *
 * @param {string} key        - chainKey (provider|baseUrl|model 형식)
 * @param {number} limit      - 최대 동시 점유 슬롯 수
 * @param {number} waitTimeoutMs - 슬롯 대기 타임아웃 (ms)
 * @returns {{ acquire: (timeoutMs?: number) => Promise<void>, release: () => void, active: () => number, waiting: () => number }}
 */
function getSemaphore(key, limit, waitTimeoutMs) {
  if (!_cache.has(key)) {
    _cache.set(key, createSemaphore({ key, limit, waitTimeoutMs }));
  }
  return _cache.get(key);
}

/**
 * 캐시를 완전히 초기화한다. 테스트 격리용.
 */
function resetSemaphores() {
  _cache.clear();
}

export { createSemaphore, getSemaphore, resetSemaphores };
