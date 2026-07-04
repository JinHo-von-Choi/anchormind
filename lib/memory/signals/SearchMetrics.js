/**
 * SearchMetrics - L1/L2/L3 검색 레이어 지연 시간 수집
 *
 * 작성자: 최진호
 * 작성일: 2026-03-11
 *
 * Redis List를 원형 버퍼(100샘플)로 사용하여 레이어별 P50/P90/P99를 근사.
 * Redis 미사용 시 in-memory 배열 fallback.
 */

const SAMPLE_LIMIT = 100;
const KEY_PREFIX   = "memento:latency:";
const LAYERS       = ["L1", "L2", "L3", "total"];

export class SearchMetrics {
  constructor(redisClient) {
    this.redis  = redisClient;
    this._local = { L1: [], L2: [], L3: [], total: [] };
  }

  /**
   * 레이어 지연(ms) 기록
   * @param {"L1"|"L2"|"L3"|"total"} layer
   * @param {number} ms
   */
  async record(layer, ms) {
    if (!LAYERS.includes(layer)) return;

    if (this.redis && this.redis.status === "ready") {
      const key = `${KEY_PREFIX}${layer}`;
      try {
        await this.redis.lpush(key, ms.toFixed(2));
        await this.redis.ltrim(key, 0, SAMPLE_LIMIT - 1);
      } catch { /* 무시 */ }
    } else {
      const buf = this._local[layer];
      buf.push(ms);
      if (buf.length > SAMPLE_LIMIT) buf.shift();
    }
  }

  /**
   * 레이어별 P50/P90/P99 반환
   * @returns {Promise<Object>}
   */
  async getStats() {
    const result = {};

    for (const layer of LAYERS) {
      let samples;

      if (this.redis && this.redis.status === "ready") {
        try {
          const raw = await this.redis.lrange(`${KEY_PREFIX}${layer}`, 0, -1);
          samples   = raw.map(Number);
        } catch {
          samples = [...this._local[layer]];
        }
      } else {
        samples = [...this._local[layer]];
      }

      result[layer] = this.computePercentiles(samples);
    }

    return result;
  }

  /**
   * 배열에서 P50/P90/P99 계산 (동기)
   * @param {number[]} samples
   * @returns {{ p50: number|null, p90: number|null, p99: number|null, count: number }}
   */
  computePercentiles(samples) {
    if (!samples || samples.length === 0) {
      return { p50: null, p90: null, p99: null, count: 0 };
    }

    const sorted = [...samples].sort((a, b) => a - b);
    const pct    = (p) => sorted[Math.min(Math.floor(sorted.length * p), sorted.length - 1)];

    return {
      p50  : pct(0.50),
      p90  : pct(0.90),
      p99  : pct(0.99),
      count: sorted.length
    };
  }
}

let _instance = null;

export async function getSearchMetrics() {
  if (!_instance) {
    const { redisClient } = await import("../../redis.js");
    _instance = new SearchMetrics(redisClient);
  }
  return _instance;
}
