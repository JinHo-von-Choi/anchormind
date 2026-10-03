/**
 * Sliding Window Rate Limiter (in-process)
 * IP 기반 또는 API 키 기반으로 사용 가능한 범용 구현.
 *
 * 작성자: 최진호
 * 작성일: 2026-03-08
 * 수정일: 2026-03-29 (API 키별 rate limiting 지원)
 */

export class RateLimiter {
  /**
   * @param {{ windowMs: number, maxRequests: number }} opts
   */
  constructor({ windowMs = 60_000, maxRequests = 120 } = {}) {
    this.windowMs    = windowMs;
    this.maxRequests = maxRequests;
    this._buckets    = new Map();
  }

  /**
   * @param {string} key  rate limit 기준 키 (예: `ip:1.2.3.4` 또는 `key:abc123`)
   * @returns {boolean}
   */
  allow(key) {
    const now    = Date.now();
    const cutoff = now - this.windowMs;
    let   hits   = this._buckets.get(key);

    if (!hits) {
      hits       = [];
      this._buckets.set(key, hits);
    }

    while (hits.length > 0 && hits[0] <= cutoff) {
      hits.shift();
    }

    if (hits.length >= this.maxRequests) {
      return false;
    }

    hits.push(now);
    return true;
  }

  /**
   * 요청을 기록하지 않고 지금 하나를 더 받을 수 있는지 본다.
   *
   * @param {string} key
   * @returns {boolean}
   */
  peek(key) {
    const hits = this._buckets.get(key);
    if (!hits) return true;
    const cutoff = Date.now() - this.windowMs;
    let   live   = 0;
    for (const t of hits) if (t > cutoff) live++;
    return live < this.maxRequests;
  }

  cleanup() {
    const cutoff = Date.now() - this.windowMs;
    for (const [key, hits] of this._buckets) {
      while (hits.length > 0 && hits[0] <= cutoff) {
        hits.shift();
      }
      if (hits.length === 0) {
        this._buckets.delete(key);
      }
    }
  }

  get size() {
    return this._buckets.size;
  }

  destroy() {
    this._buckets.clear();
  }
}

/**
 * IP 및 API 키 이중 Rate Limiter.
 * keyId가 있으면 키 기반 limit 적용, 없으면 IP 기반 limit fallback.
 */
export class DualRateLimiter {
  /**
   * @param {{ windowMs: number, perIp: number, perKey: number }} opts
   */
  constructor({ windowMs = 60_000, perIp = 30, perKey = 100 } = {}) {
    this._ipLimiter  = new RateLimiter({ windowMs, maxRequests: perIp });
    this._keyLimiter = new RateLimiter({ windowMs, maxRequests: perKey });
    this.windowMs    = windowMs;
  }

  /**
   * @param {string}      clientIp
   * @param {string|null} [keyId=null]  인증된 API 키 ID (없으면 IP fallback)
   * @returns {boolean}
   */
  allow(clientIp, keyId = null) {
    if (keyId) {
      return this._keyLimiter.allow(`key:${keyId}`);
    }
    return this._ipLimiter.allow(`ip:${clientIp}`);
  }

  cleanup() {
    this._ipLimiter.cleanup();
    this._keyLimiter.cleanup();
  }

  get size() {
    return this._ipLimiter.size + this._keyLimiter.size;
  }

  destroy() {
    this._ipLimiter.destroy();
    this._keyLimiter.destroy();
  }
}
