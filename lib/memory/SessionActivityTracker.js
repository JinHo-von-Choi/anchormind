/**
 * SessionActivityTracker - 세션별 도구 호출 및 파편 활동 추적
 *
 * 작성자: 최진호
 * 작성일: 2026-02-28
 *
 * Redis Hash(frag:activity:{sessionId})에 세션 내 활동을 기록한다.
 * AutoReflect가 세션 종료 시 이 데이터를 기반으로 요약을 생성.
 */

import { redisClient } from "../redis.js";
import { logWarn }    from "../logger.js";

const KEY_PREFIX = "frag:activity:";
const TTL        = 86400;

export class SessionActivityTracker {
  /**
   * 세션 활동 기록
   *
   * @param {string} sessionId
   * @param {Object} data - { tool, keywords?, fragmentId?, action? }
   */
  static async record(sessionId, data) {
    if (!sessionId || !redisClient || redisClient.status !== "ready") return;

    const key = `${KEY_PREFIX}${sessionId}`;

    try {
      const now  = new Date().toISOString();
      const log  = await this._getLog(key);

      log.lastActivity = now;
      if (!log.startedAt) log.startedAt = now;

      /** 도구 호출 카운트 */
      if (data.tool) {
        if (!log.toolCalls) log.toolCalls = {};
        log.toolCalls[data.tool] = (log.toolCalls[data.tool] || 0) + 1;
      }

      /** 키워드 수집 */
      if (data.keywords && Array.isArray(data.keywords)) {
        if (!log.keywords) log.keywords = [];
        for (const kw of data.keywords) {
          if (!log.keywords.includes(kw)) log.keywords.push(kw);
        }
        if (log.keywords.length > 50) log.keywords = log.keywords.slice(-50);
      }

      /** searchPath 추적 */
      if (data.searchPath) {
        if (!log.searchPaths) log.searchPaths = [];
        log.searchPaths.push(data.searchPath);
        if (log.searchPaths.length > 50) log.searchPaths = log.searchPaths.slice(-50);
      }

      /** 파편 ID 수집 */
      if (data.fragmentId) {
        if (!log.fragments) log.fragments = [];
        if (!log.fragments.includes(data.fragmentId)) {
          log.fragments.push(data.fragmentId);
        }
        if (log.fragments.length > 100) log.fragments = log.fragments.slice(-100);
      }

      /** reflected 상태 관리 */
      if (data.action === "reflected") {
        log.reflected = true;
      }

      await redisClient.setex(key, TTL, JSON.stringify(log));
    } catch (err) {
      logWarn(`[SessionActivityTracker] record failed: ${err.message}`);
    }
  }

  /**
   * 세션 활동 로그 전체 조회
   *
   * @param {string} sessionId
   * @returns {Promise<Object|null>}
   */
  static async getActivity(sessionId) {
    if (!sessionId || !redisClient || redisClient.status !== "ready") return null;

    try {
      return await this._getLog(`${KEY_PREFIX}${sessionId}`);
    } catch {
      return null;
    }
  }

  /**
   * 세션을 reflected 상태로 표시
   *
   * @param {string} sessionId
   */
  static async markReflected(sessionId) {
    await this.record(sessionId, { action: "reflected" });
  }

  /**
   * 미반영(unreflected) 세션 목록 조회
   * Redis SCAN으로 frag:activity:* 키를 순회하여 reflected=false인 세션 반환.
   *
   * @param {number} [limit=10]
   * @returns {Promise<string[]>} sessionId 목록
   */
  static async getUnreflectedSessions(limit = 10) {
    if (!redisClient || redisClient.status !== "ready") return [];

    const result    = [];
    let   cursor    = "0";
    let   scanRound = 0;
    const MAX_SCANS = 20; // 최대 20회(COUNT 50 × 20 = 1000키) 순회 후 중단

    try {
      do {
        const [nextCursor, keys] = await redisClient.scan(
          cursor, "MATCH", `${KEY_PREFIX}*`, "COUNT", 50
        );
        cursor = nextCursor;
        scanRound++;

        for (const key of keys) {
          if (result.length >= limit) break;

          const raw = await redisClient.get(key);
          if (!raw) continue;

          const log = JSON.parse(raw);
          if (!log.reflected) {
            const sid = key.replace(KEY_PREFIX, "");
            result.push(sid);
          }
        }
      } while (cursor !== "0" && result.length < limit && scanRound < MAX_SCANS);
    } catch (err) {
      logWarn(`[SessionActivityTracker] getUnreflectedSessions failed: ${err.message}`);
    }

    return result;
  }

  /**
   * 세션 활동 삭제
   *
   * @param {string} sessionId
   */
  static async delete(sessionId) {
    if (!redisClient || redisClient.status !== "ready") return;
    try {
      await redisClient.del(`${KEY_PREFIX}${sessionId}`);
    } catch { /* 무시 */ }
  }

  /** 내부: Redis에서 로그 객체 파싱 */
  static async _getLog(key) {
    const raw = await redisClient.get(key);
    if (raw) {
      try { return JSON.parse(raw); } catch { /* 무시 */ }
    }
    return {};
  }
}
