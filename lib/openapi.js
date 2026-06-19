/**
 * OpenAPI 3.1.0 스펙 생성기
 *
 * 작성자: 최진호
 * 작성일: 2026-04-08
 *
 * 인증 레벨에 따라 다른 스펙을 반환한다.
 *   master key  → 전체 경로 (Admin REST API 포함)
 *   API key     → MCP 엔드포인트만, 권한(permissions)에 따라 도구 목록 필터
 */

import { checkPermission }          from "./rbac.js";
import { ADMIN_BASE }               from "./admin/admin-auth.js";
import {
  rememberDefinition,
  batchRememberDefinition,
  batchStatusDefinition,
  recallDefinition,
  forgetDefinition,
  linkDefinition,
  amendDefinition,
  reflectDefinition,
  contextDefinition,
  toolFeedbackDefinition,
  memoryStatsDefinition,
  memoryConsolidateDefinition,
  graphExploreDefinition,
  fragmentHistoryDefinition,
  getSkillGuideDefinition,
  reconstructHistoryDefinition,
  searchTracesDefinition
} from "./tools/memory-schemas.js";
import { checkUpdateDefinition, applyUpdateDefinition } from "./tools/update-tools.js";

const ALL_TOOL_DEFINITIONS = [
  rememberDefinition,
  batchRememberDefinition,
  batchStatusDefinition,
  recallDefinition,
  forgetDefinition,
  linkDefinition,
  amendDefinition,
  reflectDefinition,
  contextDefinition,
  toolFeedbackDefinition,
  memoryStatsDefinition,
  memoryConsolidateDefinition,
  graphExploreDefinition,
  fragmentHistoryDefinition,
  getSkillGuideDefinition,
  reconstructHistoryDefinition,
  searchTracesDefinition,
  checkUpdateDefinition,
  applyUpdateDefinition
];

/** permissions 배열 기준으로 호출 가능한 도구만 추출 */
function getAvailableTools(permissions) {
  if (!permissions) return ALL_TOOL_DEFINITIONS;
  return ALL_TOOL_DEFINITIONS.filter(def => checkPermission(permissions, def.name).allowed);
}

/** ───────────────── 공통 스키마 ───────────────── */

const BEARER_AUTH_REF    = { bearerAuth: [] };
const BEARER_AUTH_SCHEME = {
  type        : "http",
  scheme      : "bearer",
  description : "Master key (MEMENTO_ACCESS_KEY 환경변수) 또는 DB API key (mmcp_ prefix)"
};

const JSON_RPC_REQUEST_SCHEMA = {
  type      : "object",
  required  : ["jsonrpc", "method"],
  properties: {
    jsonrpc: { type: "string", enum: ["2.0"] },
    method : { type: "string", description: "MCP method (tools/call, tools/list, initialize 등)" },
    params : { type: "object" },
    id     : { type: ["string", "number", "null"] }
  }
};

const JSON_RPC_RESPONSE_SCHEMA = {
  type      : "object",
  properties: {
    jsonrpc: { type: "string", enum: ["2.0"] },
    result : { type: "object" },
    error  : {
      type      : "object",
      properties: {
        code   : { type: "integer" },
        message: { type: "string" }
      }
    },
    id: { type: ["string", "number", "null"] }
  }
};

/** ───────────────── 경로 빌더 ───────────────── */

function buildPublicPaths() {
  return {
    "/health": {
      get: {
        summary    : "Health check",
        operationId: "getHealth",
        security   : [],
        responses  : {
          200: {
            description: "Service healthy",
            content    : {
              "application/json": {
                schema: {
                  type      : "object",
                  properties: {
                    status : { type: "string", enum: ["ok"] },
                    version: { type: "string" },
                    uptime : { type: "number" }
                  }
                }
              }
            }
          }
        }
      }
    },
    "/openapi.json": {
      get: {
        summary    : "OpenAPI 스펙 (인증 레벨에 따라 필터됨)",
        operationId: "getOpenApiSpec",
        security   : [BEARER_AUTH_REF],
        responses  : {
          200: {
            description: "OpenAPI 3.1.0 specification",
            content    : { "application/json": { schema: { type: "object" } } }
          },
          401: { description: "Unauthorized" }
        }
      }
    },
    "/.well-known/oauth-authorization-server": {
      get: {
        summary    : "OAuth 2.0 Authorization Server Metadata (RFC 8414)",
        operationId: "getOAuthServerMetadata",
        security   : [],
        responses  : { 200: { description: "Authorization server metadata", content: { "application/json": { schema: { type: "object" } } } } }
      }
    },
    "/.well-known/oauth-protected-resource": {
      get: {
        summary    : "OAuth 2.0 Protected Resource Metadata (RFC 9728)",
        operationId: "getOAuthResourceMetadata",
        security   : [],
        responses  : { 200: { description: "Protected resource metadata", content: { "application/json": { schema: { type: "object" } } } } }
      }
    }
  };
}

function buildMcpPaths(availableTools) {
  return {
    "/mcp": {
      post: {
        summary    : "MCP JSON-RPC 2.0 (Streamable HTTP)",
        description: "메인 MCP 프로토콜 엔드포인트. `Accept: text/event-stream` 헤더 포함 시 스트리밍 응답.",
        operationId: "mcpPost",
        security   : [BEARER_AUTH_REF],
        "x-mcp-tools": availableTools.map(d => ({
          name       : d.name,
          description: d.description,
          inputSchema: d.inputSchema
        })),
        requestBody: {
          required: true,
          content : {
            "application/json": {
              schema  : JSON_RPC_REQUEST_SCHEMA,
              examples: {
                toolsList: {
                  summary: "도구 목록 조회",
                  value  : { jsonrpc: "2.0", method: "tools/list", id: 1 }
                },
                toolsCall: {
                  summary: "도구 호출",
                  value  : {
                    jsonrpc: "2.0",
                    method : "tools/call",
                    params : { name: "recall", arguments: { query: "검색어", limit: 5 } },
                    id     : 2
                  }
                }
              }
            }
          }
        },
        responses: {
          200: {
            description: "JSON-RPC 응답 또는 SSE 스트림",
            content    : {
              "application/json"   : { schema: JSON_RPC_RESPONSE_SCHEMA },
              "text/event-stream"  : { schema: { type: "string" } }
            }
          },
          401: { description: "Unauthorized" }
        }
      },
      get: {
        summary    : "MCP SSE 스트림 오픈 (Streamable HTTP)",
        operationId: "mcpGet",
        security   : [BEARER_AUTH_REF],
        parameters : [
          { name: "MCP-Session-Id", in: "header", schema: { type: "string" } }
        ],
        responses: {
          200: { description: "SSE stream established", content: { "text/event-stream": { schema: { type: "string" } } } },
          401: { description: "Unauthorized" }
        }
      },
      delete: {
        summary    : "MCP 세션 종료",
        operationId: "mcpDelete",
        security   : [BEARER_AUTH_REF],
        parameters : [
          { name: "MCP-Session-Id", in: "header", required: true, schema: { type: "string" } }
        ],
        responses: {
          204: { description: "Session terminated" },
          401: { description: "Unauthorized" }
        }
      }
    }
  };
}

function buildLegacySsePaths() {
  return {
    "/sse": {
      get: {
        summary    : "Legacy SSE (deprecated — /mcp 사용 권장)",
        operationId: "legacySseGet",
        security   : [BEARER_AUTH_REF],
        responses  : {
          200: { description: "SSE stream", content: { "text/event-stream": { schema: { type: "string" } } } },
          401: { description: "Unauthorized" }
        }
      }
    },
    "/message": {
      post: {
        summary    : "Legacy SSE 메시지 (deprecated — /mcp 사용 권장)",
        operationId: "legacySsePost",
        security   : [BEARER_AUTH_REF],
        parameters : [
          { name: "sessionId", in: "query", required: true, schema: { type: "string" } }
        ],
        requestBody: { required: true, content: { "application/json": { schema: JSON_RPC_REQUEST_SCHEMA } } },
        responses  : { 200: { description: "Accepted" }, 401: { description: "Unauthorized" } }
      }
    }
  };
}

function buildMetricsPath() {
  return {
    "/metrics": {
      get: {
        summary    : "Prometheus 메트릭",
        operationId: "getMetrics",
        security   : [],
        responses  : {
          200: { description: "Prometheus text format", content: { "text/plain": { schema: { type: "string" } } } }
        }
      }
    }
  };
}

function buildOAuthPaths() {
  return {
    "/authorize": {
      get: {
        summary    : "OAuth 2.0 인가 엔드포인트 (동의 페이지)",
        operationId: "authorizeGet",
        security   : [],
        parameters : [
          { name: "response_type",         in: "query", required: true, schema: { type: "string", enum: ["code"] } },
          { name: "client_id",             in: "query", required: true, schema: { type: "string" } },
          { name: "redirect_uri",          in: "query", schema: { type: "string" } },
          { name: "scope",                 in: "query", schema: { type: "string" } },
          { name: "state",                 in: "query", schema: { type: "string" } },
          { name: "code_challenge",        in: "query", schema: { type: "string" } },
          { name: "code_challenge_method", in: "query", schema: { type: "string" } }
        ],
        responses: {
          200: { description: "동의 페이지 HTML" },
          302: { description: "신뢰 도메인 자동 승인 후 리다이렉트" }
        }
      },
      post: {
        summary    : "OAuth 2.0 인가 엔드포인트 (폼 제출)",
        operationId: "authorizePost",
        security   : [],
        requestBody: {
          content: {
            "application/x-www-form-urlencoded": {
              schema: {
                type      : "object",
                properties: {
                  approved: { type: "string", enum: ["true", "false"] },
                  state   : { type: "string" }
                }
              }
            }
          }
        },
        responses: { 302: { description: "authorization code 또는 에러와 함께 리다이렉트" } }
      }
    },
    "/token": {
      post: {
        summary    : "OAuth 2.0 토큰 엔드포인트",
        operationId: "postToken",
        security   : [],
        requestBody: {
          required: true,
          content : {
            "application/x-www-form-urlencoded": {
              schema: {
                type      : "object",
                required  : ["grant_type"],
                properties: {
                  grant_type    : { type: "string", enum: ["authorization_code", "refresh_token"] },
                  code          : { type: "string" },
                  redirect_uri  : { type: "string" },
                  client_id     : { type: "string" },
                  code_verifier : { type: "string" },
                  refresh_token : { type: "string" }
                }
              }
            }
          }
        },
        responses: {
          200: {
            description: "액세스 토큰",
            content    : {
              "application/json": {
                schema: {
                  type      : "object",
                  properties: {
                    access_token : { type: "string" },
                    token_type   : { type: "string" },
                    expires_in   : { type: "integer" },
                    refresh_token: { type: "string" }
                  }
                }
              }
            }
          },
          400: { description: "Invalid request" }
        }
      }
    },
    "/register": {
      post: {
        summary    : "OAuth 2.0 동적 클라이언트 등록 (RFC 7591)",
        operationId: "postRegister",
        security   : [],
        requestBody: {
          required: true,
          content : {
            "application/json": {
              schema: {
                type      : "object",
                properties: {
                  client_name   : { type: "string" },
                  redirect_uris : { type: "array", items: { type: "string" } },
                  scope         : { type: "string" }
                }
              }
            }
          }
        },
        responses: {
          201: { description: "클라이언트 등록 완료", content: { "application/json": { schema: { type: "object" } } } },
          400: { description: "Invalid request" }
        }
      }
    }
  };
}

function buildAdminAuthPaths(b) {
  return {
    [`${b}/auth`]: {
      post: {
        summary    : "Admin 로그인",
        operationId: "adminAuth",
        security   : [BEARER_AUTH_REF],
        requestBody: {
          content: {
            "application/json"                  : { schema: { type: "object" } },
            "application/x-www-form-urlencoded" : { schema: { type: "object", properties: { key: { type: "string" } } } }
          }
        },
        responses: {
          200: { description: "세션 쿠키 발급" },
          401: { description: "Invalid key" }
        }
      }
    },
    [`${b}/stats`]: {
      get: {
        summary    : "시스템 통계",
        operationId: "adminGetStats",
        security   : [BEARER_AUTH_REF],
        responses  : {
          200: {
            description: "통계 데이터",
            content    : {
              "application/json": {
                schema: {
                  type      : "object",
                  properties: {
                    fragments     : { type: "integer" },
                    sessions      : { type: "integer" },
                    apiCallsToday : { type: "integer" },
                    activeKeys    : { type: "integer" },
                    uptime        : { type: "integer" },
                    db            : { type: "string" },
                    redis         : { type: "string" }
                  }
                }
              }
            }
          }
        }
      }
    },
    [`${b}/activity`]: {
      get: {
        summary    : "최근 파편 활동 (최대 10건)",
        operationId: "adminGetActivity",
        security   : [BEARER_AUTH_REF],
        responses  : { 200: { description: "활동 목록", content: { "application/json": { schema: { type: "array", items: { type: "object" } } } } } }
      }
    }
  };
}

function buildAdminKeyPaths(b) {
  return {
    [`${b}/keys`]: {
      get: {
        summary    : "API 키 목록 조회",
        operationId: "adminListKeys",
        security   : [BEARER_AUTH_REF],
        responses  : { 200: { description: "API 키 목록", content: { "application/json": { schema: { type: "array" } } } } }
      },
      post: {
        summary    : "API 키 생성",
        operationId: "adminCreateKey",
        security   : [BEARER_AUTH_REF],
        requestBody: {
          required: true,
          content : {
            "application/json": {
              schema: {
                type      : "object",
                required  : ["name"],
                properties: {
                  name         : { type: "string" },
                  permissions  : { type: "array", items: { type: "string", enum: ["read", "write", "admin"] } },
                  daily_limit  : { type: "integer" }
                }
              }
            }
          }
        },
        responses: {
          201: { description: "생성된 API 키 (raw key는 최초 1회만 반환)", content: { "application/json": { schema: { type: "object" } } } },
          409: { description: "Duplicate name" }
        }
      }
    },
    [`${b}/keys/{id}`]: {
      put: {
        summary    : "API 키 상태 변경",
        operationId: "adminUpdateKeyStatus",
        security   : [BEARER_AUTH_REF],
        parameters : [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content : { "application/json": { schema: { type: "object", properties: { status: { type: "string", enum: ["active", "inactive"] } } } } }
        },
        responses: { 200: { description: "Updated" }, 404: { description: "Not found" } }
      },
      delete: {
        summary    : "API 키 삭제",
        operationId: "adminDeleteKey",
        security   : [BEARER_AUTH_REF],
        parameters : [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses  : { 204: { description: "Deleted" }, 404: { description: "Not found" } }
      }
    },
    [`${b}/keys/{id}/daily-limit`]: {
      put: {
        summary    : "일일 호출 한도 변경",
        operationId: "adminUpdateKeyDailyLimit",
        security   : [BEARER_AUTH_REF],
        parameters : [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { daily_limit: { type: "integer" } } } } } },
        responses  : { 200: { description: "Updated" }, 404: { description: "Not found" } }
      }
    },
    [`${b}/keys/{id}/fragment-limit`]: {
      put: {
        summary    : "파편 할당량 변경",
        operationId: "adminUpdateKeyFragmentLimit",
        security   : [BEARER_AUTH_REF],
        parameters : [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { fragment_limit: { type: ["integer", "null"] } } } } } },
        responses  : { 200: { description: "Updated" }, 404: { description: "Not found" } }
      }
    },
    [`${b}/keys/{id}/permissions`]: {
      put: {
        summary    : "API 키 권한 변경",
        operationId: "adminUpdateKeyPermissions",
        security   : [BEARER_AUTH_REF],
        parameters : [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { permissions: { type: "array", items: { type: "string" } } } } } } },
        responses  : { 200: { description: "Updated" }, 404: { description: "Not found" } }
      }
    },
    [`${b}/keys/{id}/workspace`]: {
      patch: {
        summary    : "API 키 기본 워크스페이스 변경",
        operationId: "adminUpdateKeyWorkspace",
        security   : [BEARER_AUTH_REF],
        parameters : [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { workspace: { type: ["string", "null"] } } } } } },
        responses  : { 200: { description: "Updated" }, 404: { description: "Not found" } }
      }
    }
  };
}

function buildAdminGroupPaths(b) {
  return {
    [`${b}/groups`]: {
      get: {
        summary    : "키 그룹 목록",
        operationId: "adminListGroups",
        security   : [BEARER_AUTH_REF],
        responses  : { 200: { description: "그룹 목록", content: { "application/json": { schema: { type: "array" } } } } }
      },
      post: {
        summary    : "키 그룹 생성",
        operationId: "adminCreateGroup",
        security   : [BEARER_AUTH_REF],
        requestBody: {
          required: true,
          content : { "application/json": { schema: { type: "object", required: ["name"], properties: { name: { type: "string" }, description: { type: "string" } } } } }
        },
        responses: { 201: { description: "Created" }, 409: { description: "Duplicate" } }
      }
    },
    [`${b}/groups/{id}`]: {
      delete: {
        summary    : "키 그룹 삭제",
        operationId: "adminDeleteGroup",
        security   : [BEARER_AUTH_REF],
        parameters : [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses  : { 204: { description: "Deleted" } }
      }
    },
    [`${b}/groups/{id}/members`]: {
      get: {
        summary    : "그룹 멤버 목록",
        operationId: "adminGetGroupMembers",
        security   : [BEARER_AUTH_REF],
        parameters : [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses  : { 200: { description: "멤버 목록" } }
      }
    },
    [`${b}/groups/{id}/members/{keyId}`]: {
      post: {
        summary    : "그룹에 키 추가",
        operationId: "adminAddKeyToGroup",
        security   : [BEARER_AUTH_REF],
        parameters : [
          { name: "id",    in: "path", required: true, schema: { type: "string" } },
          { name: "keyId", in: "path", required: true, schema: { type: "string" } }
        ],
        responses: { 200: { description: "Added" } }
      },
      delete: {
        summary    : "그룹에서 키 제거",
        operationId: "adminRemoveKeyFromGroup",
        security   : [BEARER_AUTH_REF],
        parameters : [
          { name: "id",    in: "path", required: true, schema: { type: "string" } },
          { name: "keyId", in: "path", required: true, schema: { type: "string" } }
        ],
        responses: { 204: { description: "Removed" } }
      }
    }
  };
}

function buildAdminSessionPaths(b) {
  return {
    [`${b}/sessions`]: {
      get: {
        summary    : "활성 세션 목록",
        operationId: "adminListSessions",
        security   : [BEARER_AUTH_REF],
        responses  : { 200: { description: "세션 목록" } }
      }
    },
    [`${b}/sessions/cleanup`]: {
      post: {
        summary    : "만료 세션 정리",
        operationId: "adminCleanupSessions",
        security   : [BEARER_AUTH_REF],
        responses  : { 200: { description: "정리 결과" } }
      }
    },
    [`${b}/sessions/reflect-all`]: {
      post: {
        summary    : "전체 세션 reflect 트리거",
        operationId: "adminReflectAllSessions",
        security   : [BEARER_AUTH_REF],
        responses  : { 200: { description: "Result" } }
      }
    },
    [`${b}/sessions/{id}`]: {
      get: {
        summary    : "세션 상세 조회",
        operationId: "adminGetSession",
        security   : [BEARER_AUTH_REF],
        parameters : [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses  : { 200: { description: "세션 상세" }, 404: { description: "Not found" } }
      },
      delete: {
        summary    : "세션 삭제",
        operationId: "adminDeleteSession",
        security   : [BEARER_AUTH_REF],
        parameters : [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses  : { 204: { description: "Deleted" } }
      }
    },
    [`${b}/sessions/{id}/reflect`]: {
      post: {
        summary    : "특정 세션 reflect 트리거",
        operationId: "adminReflectSession",
        security   : [BEARER_AUTH_REF],
        parameters : [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses  : { 200: { description: "Result" } }
      }
    }
  };
}

function buildAdminLogPaths(b) {
  return {
    [`${b}/logs/files`]: {
      get: {
        summary    : "로그 파일 목록",
        operationId: "adminListLogFiles",
        security   : [BEARER_AUTH_REF],
        responses  : { 200: { description: "파일 목록" } }
      }
    },
    [`${b}/logs/read`]: {
      get: {
        summary    : "로그 파일 내용 조회",
        operationId: "adminReadLog",
        security   : [BEARER_AUTH_REF],
        parameters : [
          { name: "file",  in: "query", required: true, schema: { type: "string" } },
          { name: "lines", in: "query", schema: { type: "integer", default: 100 } }
        ],
        responses: { 200: { description: "로그 라인" } }
      }
    },
    [`${b}/logs/stats`]: {
      get: {
        summary    : "로그 통계",
        operationId: "adminGetLogStats",
        security   : [BEARER_AUTH_REF],
        responses  : { 200: { description: "통계" } }
      }
    }
  };
}

function buildAdminDataPaths(b) {
  return {
    [`${b}/memory`]: {
      get: {
        summary    : "메모리 관리 (파편 조회, 통합 등)",
        operationId: "adminGetMemory",
        security   : [BEARER_AUTH_REF],
        responses  : { 200: { description: "메모리 데이터" } }
      }
    },
    [`${b}/export`]: {
      get: {
        summary    : "파편 내보내기",
        operationId: "adminExport",
        security   : [BEARER_AUTH_REF],
        parameters : [
          { name: "format", in: "query", schema: { type: "string", enum: ["json", "csv"], default: "json" } }
        ],
        responses: {
          200: {
            description: "내보내기 데이터",
            content    : {
              "application/json": { schema: { type: "array" } },
              "text/csv"        : { schema: { type: "string" } }
            }
          }
        }
      }
    },
    [`${b}/import`]: {
      post: {
        summary    : "파편 가져오기",
        operationId: "adminImport",
        security   : [BEARER_AUTH_REF],
        requestBody: { required: true, content: { "application/json": { schema: { type: "array" } } } },
        responses  : { 200: { description: "가져오기 결과" }, 400: { description: "Invalid format" } }
      }
    }
  };
}

function buildAdminPaths() {
  const b = ADMIN_BASE;
  return {
    ...buildAdminAuthPaths(b),
    ...buildAdminKeyPaths(b),
    ...buildAdminGroupPaths(b),
    ...buildAdminSessionPaths(b),
    ...buildAdminLogPaths(b),
    ...buildAdminDataPaths(b)
  };
}

/** ───────────────── 메인 빌더 ───────────────── */

/**
 * OpenAPI 스펙 생성
 * @param {boolean}        isMaster    - true: master key, false: DB API key
 * @param {string[]|null}  permissions - API key의 permissions 배열 (master면 null)
 * @returns {object} OpenAPI 3.1.0 spec
 */
export function buildSpec(isMaster, permissions) {
  const availableTools = getAvailableTools(isMaster ? null : permissions);

  const description = isMaster
    ? "전체 API — master key"
    : `API key 뷰 — permissions: [${(permissions ?? []).join(", ")}] | 사용 가능한 MCP 도구: ${availableTools.length}/${ALL_TOOL_DEFINITIONS.length}`;

  const paths = {
    ...buildPublicPaths(),
    ...buildMcpPaths(availableTools),
    ...(isMaster ? buildLegacySsePaths() : {}),
    ...(isMaster ? buildMetricsPath()    : {}),
    ...(isMaster ? buildOAuthPaths()     : {}),
    ...(isMaster ? buildAdminPaths()     : {})
  };

  return {
    openapi   : "3.1.0",
    info      : {
      title      : "Memento MCP Server",
      version    : "3.2.0",
      description
    },
    servers   : [{ url: "/" }],
    security  : [{ bearerAuth: [] }],
    components: {
      securitySchemes: { bearerAuth: BEARER_AUTH_SCHEME }
    },
    paths
  };
}
