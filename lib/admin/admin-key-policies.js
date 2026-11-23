/**
 * Admin: 키 보존 정책, workspace 별칭, 그룹 파편 상한 라우트
 *
 * 작성자: 최진호
 * 작성일: 2026-11-04
 *
 * 저장소는 RetentionPolicyStore, WorkspaceAliasStore, ApiKeyStore(updateGroupFragmentLimit)다. 바꾸는 라우트는 해당 키
 * (그룹은 멤버 키 전부)의 캐시를 지우고 다른 프로세스에 알린다(lib/keys/invalidation.js).
 */

import { readJsonBody }                 from "../utils.js";
import { logError }                     from "../logger.js";
import { safeErrorMessage, ADMIN_BASE } from "./admin-auth.js";
import { noteAdminAudit }               from "./admin-audit-actions.js";
import { invalidateKeys }               from "../keys/invalidation.js";
import { updateGroupFragmentLimit }     from "./ApiKeyStore.js";
import { groupMemberKeyIds }            from "./group-access.js";
import {
  listRetentionPolicies, setRetentionPolicy, normalizeRetentionInput, RetentionPolicyError,
  listRetentionScopes, setRetentionScope, normalizeScopeInput, previewRetentionScope, listAllRetentionScopes,
  changedScopeFields
} from "./RetentionPolicyStore.js";
import { adminPrincipalOf, requireCapability } from "./AdminAuthz.js";

/** 자동 정리 모드를 바꾸는 능력. 보존 기간(일수)은 key.policy로 바꾸고, 모드와 재개 시각은 이 능력이 더 필요하다. */
const RETENTION_MANAGE_CAP = "retention.manage";
import {
  listWorkspaceAliases, setWorkspaceAlias, suggestWorkspaceAliases, normalizeAliasInput, WorkspaceAliasError
} from "./WorkspaceAliasStore.js";

/** 라우트 처리기. 키의 보존 정책 목록. 응답을 직접 쓴다. */
async function getRetention(req, res, m) {
  try {
    res.statusCode = 200;
    res.end(JSON.stringify({ keyId: m[1], policies: await listRetentionPolicies(m[1]) }));
  } catch (err) {
    logError("[Admin] listRetentionPolicies error:", err);
    res.statusCode = 500;
    res.end(JSON.stringify({ error: safeErrorMessage(err) }));
  }
}

/** 라우트 처리기. 보존 정책 하나를 넣거나 바꾸거나 지운다(max_age_days null). 응답을 직접 쓴다. */
async function putRetention(req, res, m) {
  try {
    const input  = normalizeRetentionInput(await readJsonBody(req));
    const result = await setRetentionPolicy(m[1], input);
    noteAdminAudit(res, { detail: { workspace: result.workspace, before: { max_age_days: result.previous }, after: { max_age_days: result.max_age_days } } });
    res.statusCode = 200;
    res.end(JSON.stringify({ success: true, ...result }));
  } catch (err) {
    if (err instanceof RetentionPolicyError) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: err.message }));
      return;
    }
    if (err.statusCode === 413) {
      res.statusCode = 413;
      res.end(JSON.stringify({ error: "Payload too large" }));
      return;
    }
    /** 없는 키(외래 키 위반) */
    if (err.code === "23503") {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "Key not found" }));
      return;
    }
    logError("[Admin] setRetentionPolicy error:", err);
    res.statusCode = 500;
    res.end(JSON.stringify({ error: safeErrorMessage(err) }));
  }
}

/** 라우트 처리기. 키의 workspace 별칭 목록. 응답을 직접 쓴다. */
async function getWorkspaceAliases(req, res, m) {
  try {
    res.statusCode = 200;
    res.end(JSON.stringify({ keyId: m[1], aliases: await listWorkspaceAliases(m[1]) }));
  } catch (err) {
    logError("[Admin] listWorkspaceAliases error:", err);
    res.statusCode = 500;
    res.end(JSON.stringify({ error: safeErrorMessage(err) }));
  }
}

/** 라우트 처리기. 별칭 하나를 넣거나 바꾸거나 지운다(workspace null). 응답을 직접 쓴다. */
async function putWorkspaceAlias(req, res, m) {
  try {
    const body   = await readJsonBody(req);
    const result = await setWorkspaceAlias(m[1], normalizeAliasInput(body?.alias, body?.workspace ?? null));
    invalidateKeys([m[1]]);
    noteAdminAudit(res, { detail: { alias: result.alias, before: { workspace: result.previous }, after: { workspace: result.workspace } } });
    res.statusCode = 200;
    res.end(JSON.stringify({ success: true, ...result }));
  } catch (err) {
    if (err instanceof WorkspaceAliasError) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: err.message }));
      return;
    }
    if (err.statusCode === 413) {
      res.statusCode = 413;
      res.end(JSON.stringify({ error: "Payload too large" }));
      return;
    }
    if (err.code === "23503") {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "Key not found" }));
      return;
    }
    logError("[Admin] setWorkspaceAlias error:", err);
    res.statusCode = 500;
    res.end(JSON.stringify({ error: safeErrorMessage(err) }));
  }
}

/** 라우트 처리기. 별칭 후보(경로형 workspace와 같은 이름의 일반 workspace). 응답을 직접 쓴다. */
async function workspaceAliasSuggestions(req, res) {
  try {
    const url = new URL(req.url, "http://localhost");
    res.statusCode = 200;
    res.end(JSON.stringify({ suggestions: await suggestWorkspaceAliases(url.searchParams.get("key_id") || null) }));
  } catch (err) {
    logError("[Admin] suggestWorkspaceAliases error:", err);
    res.statusCode = 500;
    res.end(JSON.stringify({ error: safeErrorMessage(err) }));
  }
}

/** 라우트 처리기. 그룹 파편 상한을 바꾼다. 응답을 직접 쓴다. */
async function setGroupFragmentLimit(req, res, m) {
  try {
    const body  = await readJsonBody(req);
    const limit = body.fragment_limit;
    if (limit !== null && (!Number.isInteger(limit) || limit < 0)) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "fragment_limit must be null, 0, or a positive integer" }));
      return;
    }
    const result = await updateGroupFragmentLimit(m[1], limit);
    if (!result) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "Group not found" }));
      return;
    }
    if (result.belowUsage) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "limit_below_usage", used: result.used, requested: limit }));
      return;
    }
    /** 멤버 키의 할당량 사용량 캐시를 지운다. 지우지 않으면 캐시 시간 동안 바뀌기 전 상한으로 판정한다. */
    invalidateKeys(await groupMemberKeyIds(m[1]));
    noteAdminAudit(res, { detail: { before: { fragment_limit: result.previous }, after: { fragment_limit: result.fragment_limit } } });
    res.statusCode = 200;
    res.end(JSON.stringify({ success: true, fragment_limit: result.fragment_limit, used: result.used }));
  } catch (err) {
    if (err.statusCode === 413) {
      res.statusCode = 413;
      res.end(JSON.stringify({ error: "Payload too large" }));
      return;
    }
    logError("[Admin] setGroupFragmentLimit error:", err);
    res.statusCode = 500;
    res.end(JSON.stringify({ error: safeErrorMessage(err) }));
  }
}

/** 라우트 처리기. 키의 범위별 보존 설정(저장 값, 적용 값과 출처, workspace 목록, 할당량). 응답을 직접 쓴다. */
async function getRetentionScopes(req, res, m) {
  try {
    res.statusCode = 200;
    res.end(JSON.stringify(await listRetentionScopes(m[1])));
  } catch (err) {
    logError("[Admin] listRetentionScopes error:", err);
    res.statusCode = 500;
    res.end(JSON.stringify({ error: safeErrorMessage(err) }));
  }
}

/**
 * 라우트 처리기. 범위 하나의 자동 정리와 만료 없음을 바꾼다. 자동 정리(autoLifecycle)를 보내면 retention.manage가
 * 더 필요하다(없으면 403, 아무것도 바꾸지 않는다). 바꾼 뒤 키 캐시를 지워 보존 판정을 다시 읽게 한다.
 */
async function putRetentionScope(req, res, m) {
  try {
    const input = normalizeScopeInput(await readJsonBody(req));
    if (input.autoLifecycle !== undefined
        && !requireCapability(req, res, { principal: adminPrincipalOf(req), cap: RETENTION_MANAGE_CAP })) return;
    const result = await setRetentionScope(m[1], input);
    invalidateKeys([m[1]]);
    noteAdminAudit(res, { detail: { workspace: result.workspace, ...changedScopeFields(result.before, result.after) } });
    res.statusCode = 200;
    res.end(JSON.stringify({ success: true, ...result }));
  } catch (err) {
    if (err instanceof RetentionPolicyError) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: err.message }));
      return;
    }
    if (err.statusCode === 413) {
      res.statusCode = 413;
      res.end(JSON.stringify({ error: "Payload too large" }));
      return;
    }
    if (err.code === "23503") {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "Key not found" }));
      return;
    }
    logError("[Admin] setRetentionScope error:", err);
    res.statusCode = 500;
    res.end(JSON.stringify({ error: safeErrorMessage(err) }));
  }
}

/** 라우트 처리기. 범위 하나에서 자동 정리를 켜면 다음 주기에 손댈 수를 센다. 응답을 직접 쓴다. */
async function getRetentionPreview(req, res, m, url) {
  try {
    const ws = url.searchParams.get("workspace");
    res.statusCode = 200;
    res.end(JSON.stringify(await previewRetentionScope(m[1], ws === null || ws === "" ? null : ws)));
  } catch (err) {
    logError("[Admin] previewRetentionScope error:", err);
    res.statusCode = 500;
    res.end(JSON.stringify({ error: safeErrorMessage(err) }));
  }
}

/** 라우트 처리기. 모든 키에서 자동 정리가 꺼졌거나 재개 대기 중이거나 만료 없음인 범위. 응답을 직접 쓴다. */
async function getAllRetentionScopes(req, res) {
  try {
    res.statusCode = 200;
    res.end(JSON.stringify(await listAllRetentionScopes()));
  } catch (err) {
    logError("[Admin] listAllRetentionScopes error:", err);
    res.statusCode = 500;
    res.end(JSON.stringify({ error: safeErrorMessage(err) }));
  }
}

const exact = (path) => (pathname) => (pathname === path ? [] : null);
const regex = (re)   => (pathname) => pathname.match(re);

const ROUTES = [
  { method: "GET",    match: regex(new RegExp(`^${ADMIN_BASE}/keys/([^/]+)/retention$`)),         handler: getRetention },
  { method: "PUT",    match: regex(new RegExp(`^${ADMIN_BASE}/keys/([^/]+)/retention$`)),         handler: putRetention },
  { method: "GET",    match: regex(new RegExp(`^${ADMIN_BASE}/keys/([^/]+)/retention/scopes$`)),  handler: getRetentionScopes },
  { method: "PUT",    match: regex(new RegExp(`^${ADMIN_BASE}/keys/([^/]+)/retention/scopes$`)),  handler: putRetentionScope },
  { method: "GET",    match: regex(new RegExp(`^${ADMIN_BASE}/keys/([^/]+)/retention/preview$`)), handler: getRetentionPreview },
  { method: "GET",    match: exact(`${ADMIN_BASE}/retention/scopes`),                             handler: getAllRetentionScopes },
  { method: "GET",    match: regex(new RegExp(`^${ADMIN_BASE}/keys/([^/]+)/workspace-aliases$`)), handler: getWorkspaceAliases },
  { method: "PUT",    match: regex(new RegExp(`^${ADMIN_BASE}/keys/([^/]+)/workspace-aliases$`)), handler: putWorkspaceAlias },
  { method: "GET",    match: exact(`${ADMIN_BASE}/workspace-aliases/suggestions`),                handler: workspaceAliasSuggestions },
  { method: "PUT",    match: regex(new RegExp(`^${ADMIN_BASE}/groups/([^/]+)/fragment-limit$`)),  handler: setGroupFragmentLimit }
];

/**
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse}  res
 * @param {URL} url
 * @returns {Promise<boolean>} 처리했으면 true
 */
export async function handleKeyPolicies(req, res, url) {
  for (const route of ROUTES) {
    if (req.method !== route.method) continue;
    const m = route.match(url.pathname);
    if (!m) continue;
    await route.handler(req, res, m, url);
    return true;
  }
  return false;
}
