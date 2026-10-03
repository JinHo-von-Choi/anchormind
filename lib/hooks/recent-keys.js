/**
 * 최근 접수한 멱등 키 목록
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 훅 처리기가 회고 이벤트를 기록한 멱등 키를 프로세스 메모리에 잠시 둔다. 같은 세션과 이벤트가 다시 오면
 * 소비자가 아직 처리하지 않았어도 DB 질의와 기록 없이 중복으로 응답한다. 항목 수와 보존 시간에 상한이 있고,
 * 가득 차면 가장 먼저 넣은 항목부터 버린다. 프로세스마다 따로 두므로 다른 인스턴스와 재시작 뒤의 중복은
 * idempotency_records 확인과 소비자 선점이 막는다.
 */

export class RecentKeys {
  /**
   * @param {{ maxEntries?: number, ttlMs?: number, clock?: () => number }} [options]
   */
  constructor({ maxEntries = 10_000, ttlMs = 600_000, clock = Date.now } = {}) {
    this.maxEntries = maxEntries;
    this.ttlMs      = ttlMs;
    this.clock      = clock;
    this._entries   = new Map();
  }

  /**
   * @param {string} key
   * @returns {boolean} 보존 시간 안에 넣은 키인가
   */
  has(key) {
    const expiresAt = this._entries.get(key);
    if (expiresAt === undefined) return false;
    if (expiresAt > this.clock()) return true;
    this._entries.delete(key);
    return false;
  }

  /**
   * @param {string} key
   */
  add(key) {
    this._entries.delete(key);
    this._entries.set(key, this.clock() + this.ttlMs);
    while (this._entries.size > this.maxEntries) {
      this._entries.delete(this._entries.keys().next().value);
    }
  }

  /** @returns {number} */
  get size() {
    return this._entries.size;
  }
}
