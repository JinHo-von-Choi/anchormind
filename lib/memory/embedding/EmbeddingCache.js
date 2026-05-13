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
 */

import { createHash } from "node:crypto";

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
    if (!this.redis || this.redis.status === "stub") return null;
    try {
      const buf = await this.redis.getBuffer(this._key(text));
      if (!buf) return null;
      const f32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
      return Array.from(f32);
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
    if (!this.redis || this.redis.status === "stub") return;
    try {
      const f32 = new Float32Array(vector);
      const buf = Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
      this.redis.set(this._key(text), buf, "EX", this.ttlSeconds).catch(() => {});
    } catch {
      /* 캐시 저장 실패는 무시 */
    }
  }
}
