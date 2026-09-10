/**
 * Memento MCP Resources 정의
 */

import { MEMORY_CONFIG } from "../../config/memory.js";
import { getPrimaryPool } from "./db.js";
import { SessionActivityTracker } from "../memory/processors/SessionActivityTracker.js";
import { SCHEMA } from "../memory/schema.js";
import { keyScopeClause } from "../memory/keyScope.js";
import { agentScopeCondition, resolveAgentScope } from "../memory/read/AgentScope.js";
import { resolveWorkspaceScope, workspaceCondition } from "../memory/read/WorkspaceScope.js";

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

function buildFragmentScope(params) {
  const agentScope = resolveAgentScope(params);
  const queryParams = [agentScope.agentId];
  const conditions = [agentScopeCondition("$1", agentScope, "f.agent_id")];
  const keyClause = keyScopeClause(queryParams, "f.key_id", {
    keyId: params._keyId ?? null,
    groupKeyIds: params._groupKeyIds
  });
  if (keyClause) conditions.push(keyClause.trim().replace(/^AND\s+/, ""));
  const workspaceScope = resolveWorkspaceScope(params);
  const workspaceClause = workspaceCondition(queryParams, workspaceScope, "f.workspace");
  if (workspaceClause) conditions.push(workspaceClause);
  conditions.push("f.valid_to IS NULL");
  return { queryParams, where: conditions.join(" AND ") };
}

/**
 * 리소스 내용 읽기
 */
export async function readResource(uri, params = {}) {
  const pool = getPrimaryPool();

  switch (uri) {
    case "memory://stats": {
      const scope = buildFragmentScope(params);
      const stats = await pool.query(`
          SELECT
            f.type,
            f.ttl_tier,
            COUNT(*) as count,
            AVG(f.importance) as avg_importance,
            AVG(f.utility_score) as avg_utility
          FROM ${SCHEMA}.fragments f
          WHERE ${scope.where}
          GROUP BY f.type, f.ttl_tier
        `, scope.queryParams);
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
      const scope = buildFragmentScope(params);
      const topics = await pool.query(`
          SELECT DISTINCT f.topic
          FROM ${SCHEMA}.fragments f
          WHERE ${scope.where}
          ORDER BY f.topic ASC
        `, scope.queryParams);
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
