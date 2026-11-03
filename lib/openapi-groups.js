/**
 * OpenAPI 문서의 키 그룹 관리 경로와 키 접근, 보존 정책, workspace 별칭 경로
 *
 * 작성자: 최진호
 * 작성일: 2026-11-04
 *
 * lib/admin/admin-keys.js의 그룹 라우트(목록, 생성, 삭제, 멤버, 멤버 권한과 공유 workspace, 실효 권한, 그룹 파편
 * 상한), 키 하나의 그룹 접근 조회(GET /keys/:id/access), 키 보존 정책(/keys/:id/retention), workspace 별칭
 * (/keys/:id/workspace-aliases, /workspace-aliases/suggestions)을 OpenAPI 경로 객체로
 * 만든다. lib/openapi.js가 관리 경로에 합친다.
 */

import { GROUP_MEMBER_PERMISSIONS } from "./memory/groupGrants.js";

/** 그룹 멤버 권한 배열 스키마 */
const MEMBER_PERMISSIONS_SCHEMA = { type: "array", items: { type: "string", enum: GROUP_MEMBER_PERMISSIONS } };

/** 공유 workspace 목록. null은 전체 공유다. */
const SHARED_WORKSPACES_SCHEMA = { type: ["array", "null"], items: { type: "string", maxLength: 128 }, maxItems: 64 };

/** 필수 JSON 본문 */
const jsonBody = (required, properties) => ({ required: true, content: { "application/json": { schema: { type: "object", required, properties } } } });

const pathParam = (name) => ({ name, in: "path", required: true, schema: { type: "string" } });

/**
 * @param {string} b 관리 API 기준 경로
 * @param {object} bearer 보안 요구 객체
 * @returns {object}
 */
export function buildAdminGroupPaths(b, bearer) {
  const security = [bearer];
  return {
    [`${b}/groups`]: {
      get: {
        summary    : "키 그룹 목록(멤버 수, 파편 상한, 상한이 있으면 멤버 전체 파편 수)",
        operationId: "adminListGroups",
        security,
        responses  : { 200: { description: "그룹 목록", content: { "application/json": { schema: { type: "array" } } } } }
      },
      post: {
        summary    : "키 그룹 생성",
        operationId: "adminCreateGroup",
        security,
        requestBody: jsonBody(["name"], { name: { type: "string" }, description: { type: "string" } }),
        responses  : { 201: { description: "Created" }, 409: { description: "Duplicate" } }
      }
    },
    [`${b}/groups/{id}`]: {
      delete: {
        summary    : "키 그룹 삭제",
        operationId: "adminDeleteGroup",
        security,
        parameters : [pathParam("id")],
        responses  : { 204: { description: "Deleted" } }
      }
    },
    [`${b}/groups/{id}/members`]: {
      get: {
        summary    : "그룹 멤버 목록(멤버별 permissions, shared_workspaces, updated_at 포함)",
        operationId: "adminGetGroupMembers",
        security,
        parameters : [pathParam("id")],
        responses  : { 200: { description: "멤버 목록" } }
      },
      post: {
        summary    : "그룹에 키 추가(permissions 생략 시 read, share, link, shared_workspaces 생략 시 전체 공유)",
        operationId: "adminAddKeyToGroup",
        security,
        parameters : [pathParam("id")],
        requestBody: jsonBody(["key_id"], { key_id: { type: "string" }, permissions: MEMBER_PERMISSIONS_SCHEMA, shared_workspaces: SHARED_WORKSPACES_SCHEMA }),
        responses  : { 200: { description: "Added" }, 400: { description: "invalid_group_permissions" } }
      }
    },
    [`${b}/groups/{id}/members/{keyId}`]: {
      patch: {
        summary    : "그룹 멤버 권한과 공유 workspace 변경(둘 중 하나 이상)",
        operationId: "adminSetGroupMemberPermissions",
        security,
        parameters : [pathParam("id"), pathParam("keyId")],
        requestBody: jsonBody([], { permissions: MEMBER_PERMISSIONS_SCHEMA, shared_workspaces: SHARED_WORKSPACES_SCHEMA }),
        responses  : {
          200: { description: "{ keyId, groupId, permissions, previous, sharedWorkspaces, previousSharedWorkspaces }" },
          400: { description: "invalid_group_permissions" },
          404: { description: "Member not found" }
        }
      },
      delete: {
        summary    : "그룹에서 키 제거",
        operationId: "adminRemoveKeyFromGroup",
        security,
        parameters : [pathParam("id"), pathParam("keyId")],
        responses  : { 204: { description: "Removed" } }
      }
    },
    [`${b}/groups/{id}/effective-access`]: {
      get: {
        summary    : "멤버 쌍별 실제 권한 표(읽기, link, amend, forget, 공유 workspace)",
        operationId: "adminGetGroupEffectiveAccess",
        security,
        parameters : [pathParam("id")],
        responses  : { 200: { description: "실효 권한 표" } }
      }
    },
    [`${b}/groups/{id}/fragment-limit`]: {
      put: {
        summary    : "그룹 파편 상한 변경(멤버 키 전체의 살아 있는 파편 수, null은 상한 없음)",
        operationId: "adminUpdateGroupFragmentLimit",
        security,
        parameters : [pathParam("id")],
        requestBody: jsonBody(["fragment_limit"], { fragment_limit: { type: ["integer", "null"], minimum: 0 } }),
        responses  : { 200: { description: "{ success, fragment_limit, used }" }, 400: { description: "limit_below_usage" }, 404: { description: "Group not found" } }
      }
    }
  };
}

/**
 * 키 하나의 그룹 접근, 보존 정책, workspace 별칭 경로.
 *
 * @param {string} b 관리 API 기준 경로
 * @param {object} bearer 보안 요구 객체
 * @returns {object}
 */
export function buildAdminKeyAccessPaths(b, bearer) {
  const security = [bearer];
  return {
    [`${b}/keys/{id}/access`]: {
      get: {
        summary    : "키 하나의 그룹 접근: 읽을 수 있는 키, 받은 쓰기 권한, 공유 workspace 제한, 다른 키가 이 키 파편을 읽은 기록",
        operationId: "adminGetKeyAccess",
        security,
        parameters : [pathParam("id"), { name: "days", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 90, default: 7 } }],
        responses  : { 200: { description: "{ keyId, readableKeyIds, groupGrants, groupShareScopes, days, sharedReads }" } }
      }
    },
    [`${b}/keys/{id}/retention`]: {
      get: {
        summary    : "키 보존 정책 목록(workspace null은 키 전체)",
        operationId: "adminListKeyRetention",
        security,
        parameters : [pathParam("id")],
        responses  : { 200: { description: "{ keyId, policies: [{ workspace, max_age_days, updated_at }] }" } }
      },
      put: {
        summary    : "키 보존 정책 설정. created_at이 max_age_days보다 오래된 파편을 정리 주기가 지운다(앵커 제외). max_age_days null은 정책 삭제",
        operationId: "adminSetKeyRetention",
        security,
        parameters : [pathParam("id")],
        requestBody: jsonBody(["max_age_days"], {
          workspace   : { type: ["string", "null"], maxLength: 128 },
          max_age_days: { type: ["integer", "null"], minimum: 1, maximum: 36500 }
        }),
        responses  : { 200: { description: "{ success, workspace, previous, max_age_days }" }, 400: { description: "invalid input" }, 404: { description: "Key not found" } }
      }
    },
    [`${b}/keys/{id}/workspace-aliases`]: {
      get: {
        summary    : "키의 workspace 별칭 목록(별칭으로 들어온 요청을 정식 이름으로 바꾼다)",
        operationId: "adminListWorkspaceAliases",
        security,
        parameters : [pathParam("id")],
        responses  : { 200: { description: "{ keyId, aliases: [{ alias, workspace, created_at }] }" } }
      },
      put: {
        summary    : "workspace 별칭 설정. workspace null은 별칭 삭제. 별칭 사슬은 거부한다",
        operationId: "adminSetWorkspaceAlias",
        security,
        parameters : [pathParam("id")],
        requestBody: jsonBody(["alias"], { alias: { type: "string", maxLength: 4096 }, workspace: { type: ["string", "null"], maxLength: 128 } }),
        responses  : { 200: { description: "{ success, alias, previous, workspace }" }, 400: { description: "invalid input or alias chain" }, 404: { description: "Key not found" } }
      }
    },
    [`${b}/workspace-aliases/suggestions`]: {
      get: {
        summary    : "별칭 후보: 경로형 workspace 가운데 마지막 조각과 같은 일반 workspace가 같은 키에 있는 것",
        operationId: "adminSuggestWorkspaceAliases",
        security,
        parameters : [{ name: "key_id", in: "query", required: false, schema: { type: "string" } }],
        responses  : { 200: { description: "{ suggestions: [{ keyId, alias, workspace, aliasFragments, workspaceFragments }] }" } }
      }
    }
  };
}
