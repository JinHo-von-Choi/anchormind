/**
 * Memento MCP Resources 정의
 */

import { MEMORY_CONFIG } from "../../config/memory.js";
import { getPrimaryPool } from "./db.js";
import { SessionActivityTracker } from "../memory/processors/SessionActivityTracker.js";
import { SCHEMA } from "../memory/schema.js";

export const RESOURCES = [
  {
    uri: "memory://stats",
    name: "기억 시스템 통계",
    description: "현재 저장된 파편의 유형별, 계층별 통계 정보를 제공합니다.",
    mimeType: "application/json"
  },
  {
    uri: "memory://topics",
    name: "저장된 주제 목록",
    description: "기억 시스템에 등록된 모든 고유한 주제(topic) 목록을 제공합니다.",
    mimeType: "application/json"
  },
  {
    uri: "memory://config",
    name: "시스템 설정 정보",
    description: "중요도 가중치, 망각 임계값 등 현재 시스템 설정을 제공합니다.",
    mimeType: "application/json"
  },
  {
    uri: "memory://active-session",
    name: "현재 세션 활동 로그",
    description: "현재 세션에서 발생한 도구 호출 및 활동 요약을 제공합니다.",
    mimeType: "application/json"
  }
];

/**
 * 리소스 내용 읽기
 */
export async function readResource(uri, params = {}) {
  const pool = getPrimaryPool();

  switch (uri) {
    case "memory://stats": {
      const keyId       = params._keyId ?? null;
      const groupKeyIds = params._groupKeyIds ?? (keyId ? [keyId] : null);
      const keyIds      = groupKeyIds ?? (keyId ? [keyId] : null);

      let stats;
      if (keyIds) {
        stats = await pool.query(`
          SELECT
            type,
            ttl_tier,
            COUNT(*) as count,
            AVG(importance) as avg_importance,
            AVG(utility_score) as avg_utility
          FROM ${SCHEMA}.fragments
          WHERE key_id = ANY($1)
          GROUP BY type, ttl_tier
        `, [keyIds]);
      } else {
        stats = await pool.query(`
          SELECT
            type,
            ttl_tier,
            COUNT(*) as count,
            AVG(importance) as avg_importance,
            AVG(utility_score) as avg_utility
          FROM ${SCHEMA}.fragments
          GROUP BY type, ttl_tier
        `);
      }
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(stats.rows, null, 2)
          }
        ]
      };
    }

    case "memory://topics": {
      const keyId       = params._keyId ?? null;
      const groupKeyIds = params._groupKeyIds ?? (keyId ? [keyId] : null);
      const keyIds      = groupKeyIds ?? (keyId ? [keyId] : null);

      let topics;
      if (keyIds) {
        topics = await pool.query(`
          SELECT DISTINCT topic
          FROM ${SCHEMA}.fragments
          WHERE key_id = ANY($1)
          ORDER BY topic ASC
        `, [keyIds]);
      } else {
        topics = await pool.query(`
          SELECT DISTINCT topic
          FROM ${SCHEMA}.fragments
          ORDER BY topic ASC
        `);
      }
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(topics.rows.map(r => r.topic), null, 2)
          }
        ]
      };
    }

    case "memory://config": {
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(MEMORY_CONFIG, null, 2)
          }
        ]
      };
    }

    case "memory://active-session": {
      const sessionId = params._sessionId || null;
      let activity;

      if (!sessionId) {
        activity = { sessionId: null, status: "No session context available" };
      } else {
        const log = await SessionActivityTracker.getActivity(sessionId);
        activity  = log
          ? { sessionId, ...log }
          : { sessionId, message: "No activity recorded yet for this session" };
      }

      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(activity, null, 2)
          }
        ]
      };
    }

    default:
      throw new Error(`Unknown resource URI: ${uri}`);
  }
}
