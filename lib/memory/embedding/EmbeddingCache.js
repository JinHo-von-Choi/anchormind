/**
 * EmbeddingCache - 쿼리 임베딩 Redis 캐시 레이어
 *
 * 작성자: 최진호
 * 작성일: 2026-04-05
 *
 * recall 시 동일 쿼리의 임베딩을 Redis에 캐싱하여
 * 반복 검색 레이턴시를 50-80% 감소시킨다.
 *
 * 키 패턴: emb:q:{sha256 앞 16자}
 * 값: Float32Array → Buffer (바이너리 저장)
 *
 * 장애 격리: 모든 Redis 호출은 try-catch로 감싸고
 * 실패 시 null/무시 반환. 캐시 장애가 검색을 차단하지 않는다.
 *
 * Redis 앞에 프로세스 메모리 LRU를 둔다. 같은 세션의 반복 질의와, remember의 충돌 탐지가 만든 본문 임베딩을
 * 임베딩 작업자가 다시 만드는 경우가 Redis 왕복 없이 맞는다. Redis가 꺼져 있어도 이 캐시는 동작한다.
 * 크기는 MEMENTO_EMBEDDING_MEMORY_CACHE_SIZE(기본 512개, 0이면 끔)이고 보존 시간은 Redis TTL과 같다.
 * 벡터 하나는 Float32Array로 약 4KB(1024차원)라 기본 크기에서 2MB 남짓이다.
 */

import { createHash } from "node:crypto";
import { envInt }     from "../../config.js";

/** 키 → { vec: Float32Array, expiresAt: number }. Map의 삽입 순서를 LRU 순서로 쓴다. */
const memory = new Map();

/**
 * 메모리 캐시 크기. 호출 시점의 환경 변수를 읽는다.
 *
 * @returns {number}
 */
export function memoryCacheSize() {
  return envInt("MEMENTO_EMBEDDING_MEMORY_CACHE_SIZE", 512, { min: 0, max: 100_000, fallback: true });
}

/** 시험용: 메모리 캐시를 비운다. */
export function resetEmbeddingMemoryCache() {
  memory.clear();
}

export class EmbeddingCache {
  /**
   * @param {Object} options
   * @param {Object|null} options.redis      - ioredis 클라이언트 (null이면 항상 miss)
   * @param {number}      options.ttlSeconds - 캐시 TTL (기본 3600초 = 1시간)
   */
  constructor({ redis = null, ttlSeconds = 3600 } = {}) {
    this.redis      = redis;
    this.ttlSeconds = ttlSeconds;
  }

  /**
   * 텍스트의 SHA-256 해시 앞 16자로 Redis 키 생성
   *
   * @param {string} text - 쿼리 텍스트
   * @returns {string} emb:q:{hash16}
   */
  _key(text) {
    /** EMBEDDING_MODEL을 키에 결합하여 모델 변경 시 stale 벡터가 hit되지 않도록 한다. */
    const model = process.env.EMBEDDING_MODEL || "default";
    const hash  = createHash("sha256").update(`${model}:${text}`).digest("hex").slice(0, 16);
    return `emb:q:${hash}`;
  }

  /**
   * 캐시에서 임베딩 벡터 조회
   *
   * @param {string} text - 쿼리 텍스트
   * @returns {Promise<number[]|null>} 임베딩 배열 또는 null (miss/장애)
   */
  async get(text) {
    const key = this._key(text);
    const hit = this._memoryGet(key);
    if (hit) return hit;
    if (!this.redis || this.redis.status === "stub") return null;
    try {
      const buf = await this.redis.getBuffer(key);
      if (!buf || buf.byteLength % 4 !== 0) return null;
      /** Redis가 돌려준 Buffer는 공유 메모리의 4의 배수가 아닌 위치에서 시작할 수 있어 그 위에 Float32Array를 바로 만들면
       *  RangeError가 난다. 리틀 엔디언으로 한 칸씩 읽는다(set이 쓰는 Float32Array도 리틀 엔디언 장비 기준이다). */
      const vec = Array.from({ length: buf.byteLength / 4 }, (_, i) => buf.readFloatLE(i * 4));
      this._memorySet(key, vec);
      return vec;
    // iron-laws: ignore[IL-301] Redis 캐시를 읽지 못하면 임베딩을 새로 만든다
    } catch {
      return null;
    }
  }

  /**
   * 캐시에 임베딩 벡터 저장 (fire-and-forget)
   *
   * @param {string}   text   - 쿼리 텍스트
   * @param {number[]} vector - 임베딩 벡터
   */
  set(text, vector) {
    const key = this._key(text);
    this._memorySet(key, vector);
    if (!this.redis || this.redis.status === "stub") return;
    try {
      const f32 = new Float32Array(vector);
      const buf = Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
      // iron-laws: ignore[IL-301] 캐시 저장 실패는 다음 요청에서 임베딩을 새로 만든다
      this.redis.set(key, buf, "EX", this.ttlSeconds).catch(() => {});
    // iron-laws: ignore[IL-301] 캐시 저장 실패는 다음 요청에서 임베딩을 새로 만든다
    } catch {
      /* 캐시 저장 실패는 무시 */
    }
  }

  /**
   * 메모리 캐시에서 읽는다. 맞으면 가장 최근 항목으로 옮긴다. 호출자가 배열을 고쳐도 캐시가 바뀌지 않게 새 배열을 준다.
   *
   * @param {string} key
   * @returns {number[]|null}
   */
  _memoryGet(key) {
    const entry = memory.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      memory.delete(key);
      return null;
    }
    memory.delete(key);
    memory.set(key, entry);
    return Array.from(entry.vec);
  }

  /**
   * 메모리 캐시에 넣고 크기를 넘으면 가장 오래 안 쓴 항목부터 뺀다.
   *
   * @param {string}   key
   * @param {number[]} vector
   */
  _memorySet(key, vector) {
    const size = memoryCacheSize();
    if (size === 0 || !Array.isArray(vector) || vector.length === 0) return;
    memory.delete(key);
    memory.set(key, { vec: Float32Array.from(vector), expiresAt: Date.now() + this.ttlSeconds * 1000 });
    while (memory.size > size) memory.delete(memory.keys().next().value);
  }
}
