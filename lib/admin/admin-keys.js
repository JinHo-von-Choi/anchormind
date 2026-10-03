/**
 * Admin API 키 및 그룹 관리 핸들러
 *
 * 작성자: 최진호
 * 작성일: 2026-03-27
 */

import { readJsonBody }                          from "../utils.js";
import { logError }                              from "../logger.js";
import { logAudit }                              from "../logging/audit.js";
import { DEFAULT_PERMISSIONS, DEFAULT_DAILY_LIMIT } from "../config.js";
import {
  listApiKeys,
  createApiKey,
  updateApiKeyStatus,
  updateFragmentLimit,
  updateDailyLimit,
  updatePermissions,
  updateWorkspace,
  updateKeyPolicy,
  invalidateHardGateCache,
  invalidateAllowedWorkspacesCache,
  invalidateEgressPolicyCache,
  deleteApiKey,
  listKeyGroups,
  createKeyGroup,
  deleteKeyGroup,
  addKeyToGroup,
  removeKeyFromGroup,
  getGroupMembers,
  getFragmentCount,
  ApiKeyInUseError
} from "./ApiKeyStore.js";
import { getPrimaryPool }                from "../tools/db.js";
import { safeErrorMessage, adminAuditActor, ADMIN_BASE } from "./admin-auth.js";
import { invalidateKeyState }        from "./key-state-cache.js";
import {
  KeyPolicyValidationError,
  validateKeyPolicyPatch,
  validatePermissionList,
  diffKeyPolicy,
  formatKeyPolicyAuditDetails,
  keyPolicyAuditDetail
} from "./key-policy.js";
import { closeSessionsByKeyId }      from "../sessions.js";
import {
  rotateApiKey,
  revokeApiKey,
  updateKeyLifecycle,
  recordAccessReview
} from "./ApiKeyLifecycleStore.js";
import {
  KeyLifecycleConflictError,
  validateKeyLifecyclePatch,
  validateRevokeReason,
  resolveGraceHours,
  keyRotationGraceHours,
  diffKeyLifecycle,
  KEY_LIFECYCLE_FIELDS
} from "./key-lifecycle.js";
import { noteAdminAudit }            from "./admin-audit-actions.js";
import { SCHEMA } from "../memory/schema.js";
import { NOT_WM_ROW } from "../memory/WorkingMemorySql.js";
import { listProviderNames } from "../llm/registry.js";

/** 라우트 처리기. 응답을 직접 쓴다. */
async function listKeys(req, res) {
  try {
  const keys = await listApiKeys();
  res.statusCode = 200;
  res.end(JSON.stringify(keys));
  } catch (err) {
  logError("[Admin] listApiKeys error:", err);
  res.statusCode = 500;
  res.end(JSON.stringify({ error: safeErrorMessage(err) }));
  }
}

/** 라우트 처리기. 응답을 직접 쓴다. */
async function keyStats(req, res, m) {
  try {
  const pool = getPrimaryPool();
  const { rows: [r] } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE valid_to IS NULL)::int                                    AS total,
       COUNT(*) FILTER (WHERE valid_to IS NULL AND type='fact')::int                    AS type_fact,
       COUNT(*) FILTER (WHERE valid_to IS NULL AND type='decision')::int                AS type_decision,
       COUNT(*) FILTER (WHERE valid_to IS NULL AND type='error')::int                   AS type_error,
       COUNT(*) FILTER (WHERE valid_to IS NULL AND type='preference')::int              AS type_preference,
       COUNT(*) FILTER (WHERE valid_to IS NULL AND type='procedure')::int               AS type_procedure,
       COUNT(*) FILTER (WHERE valid_to IS NULL AND type='relation')::int                AS type_relation,
       COUNT(*) FILTER (WHERE valid_to IS NULL AND type='episode')::int                 AS type_episode,
       COUNT(*) FILTER (WHERE valid_to IS NULL AND ttl_tier='short')::int               AS ttl_short,
       COUNT(*) FILTER (WHERE valid_to IS NULL AND ttl_tier='hot')::int                 AS ttl_hot,
       COUNT(*) FILTER (WHERE valid_to IS NULL AND ttl_tier='warm')::int                AS ttl_warm,
       COUNT(*) FILTER (WHERE valid_to IS NULL AND ttl_tier='cold')::int                AS ttl_cold,
       COUNT(*) FILTER (WHERE valid_to IS NULL AND ttl_tier='permanent')::int           AS ttl_permanent,
       COUNT(*) FILTER (WHERE valid_to IS NULL AND is_anchor)::int                      AS anchors,
       COUNT(*) FILTER (WHERE valid_to IS NULL AND ttl_tier <> 'permanent' AND NOT is_anchor
                        AND created_at < NOW() - INTERVAL '60 days'
                        AND (accessed_at IS NULL OR accessed_at < NOW() - INTERVAL '60 days'))::int AS expiring_soon,
       COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::int               AS growth_7d,
       COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '28 days')::int              AS growth_28d,
       COUNT(*) FILTER (WHERE valid_to IS NULL
                        AND (accessed_at IS NULL OR accessed_at < NOW() - INTERVAL '30 days'))::int AS stale_30d
     FROM ${SCHEMA}.fragments
     WHERE key_id = $1 AND ${NOT_WM_ROW}`,
    [m[1]]
  );

  const total = r?.total ?? 0;
  res.statusCode = 200;
  res.end(JSON.stringify({
    keyId:  m[1],
    total,
    byType: {
      fact:       r?.type_fact       ?? 0,
      decision:   r?.type_decision   ?? 0,
      error:      r?.type_error      ?? 0,
      preference: r?.type_preference ?? 0,
      procedure:  r?.type_procedure  ?? 0,
      relation:   r?.type_relation   ?? 0,
      episode:    r?.type_episode    ?? 0
    },
    byTtlTier: {
      short:     r?.ttl_short     ?? 0,
      hot:       r?.ttl_hot       ?? 0,
      warm:      r?.ttl_warm      ?? 0,
      cold:      r?.ttl_cold      ?? 0,
      permanent: r?.ttl_permanent ?? 0
    },
    anchors:      r?.anchors      ?? 0,
    /** 만료 임박 근사: FragmentGC 90일 하드삭제 임계에 접근한(60일 미접근+미고정) 파편 수 */
    expiringSoon: r?.expiring_soon ?? 0,
    growth7d:     r?.growth_7d    ?? 0,
    growth28d:    r?.growth_28d   ?? 0,
    staleRatio30d: total > 0
      ? parseFloat(((r?.stale_30d ?? 0) / total).toFixed(4))
      : null
  }));
  } catch (err) {
  logError("[Admin] GET /keys/:id/stats error:", err);
  res.statusCode = 500;
  res.end(JSON.stringify({ error: safeErrorMessage(err) }));
  }
}

/**
 * 키 생성 본문의 수명 열. 하나도 없으면 빈 객체다.
 *
 * @param {object} body
 * @returns {object}
 */
function createLifecycleFields(body) {
  return KEY_LIFECYCLE_FIELDS.some((field) => Object.hasOwn(body, field)) ? validateKeyLifecyclePatch(body) : {};
}

/**
 * 감사 detail에 남길 수명 열 값. 설명은 남기지 않는다.
 *
 * @param {object} lifecycle
 * @returns {object}
 */
function lifecycleAuditValues(lifecycle) {
  return diffKeyLifecycle({}, lifecycle).after;
}

/** 라우트 처리기. 응답을 직접 쓴다. */
async function createKey(req, res) {
  try {
  const body = await readJsonBody(req);
  if (!body.name || typeof body.name !== "string") {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: "name is required" }));
    return true;
  }
  const lifecycle = createLifecycleFields(body);
  const key = await createApiKey({
    name:        body.name.trim(),
    permissions: body.permissions === undefined ? DEFAULT_PERMISSIONS : validatePermissionList(body.permissions),
    daily_limit: Number(body.daily_limit) || DEFAULT_DAILY_LIMIT,
    ...lifecycle
  });
  noteAdminAudit(res, { targetId: key.id, detail: { after: { permissions: key.permissions, daily_limit: key.daily_limit, ...lifecycleAuditValues(lifecycle) } } });
  res.statusCode = 201;
  res.end(JSON.stringify(key));
  } catch (err) {
  if (err.statusCode === 413) {
    res.statusCode = 413;
    res.end(JSON.stringify({ error: "Payload too large" }));
    return true;
  }
  if (err instanceof KeyPolicyValidationError) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: err.message, field: err.field }));
    return true;
  }
  logError("[Admin] createApiKey error:", err);
  res.statusCode = err.message.includes("unique") ? 409 : 500;
  res.end(JSON.stringify({ error: safeErrorMessage(err) }));
  }
}

/** 라우트 처리기. 응답을 직접 쓴다. */
async function setDailyLimit(req, res, m) {
  try {
  const body  = await readJsonBody(req);
  const limit = body.daily_limit;
  if (!Number.isInteger(limit) || limit < 1) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: "daily_limit must be a positive integer" }));
    return true;
  }
  const result = await updateDailyLimit(m[1], limit);
  noteAdminAudit(res, { detail: { after: { daily_limit: result.daily_limit } } });
  res.statusCode = 200;
  res.end(JSON.stringify({ success: true, daily_limit: result.daily_limit }));
  } catch (err) {
  if (err.statusCode === 413) {
    res.statusCode = 413;
    res.end(JSON.stringify({ error: "Payload too large" }));
    return true;
  }
  logError("[Admin] updateDailyLimit error:", err);
  res.statusCode = err.message === "Key not found" ? 404 : 400;
  res.end(JSON.stringify({ error: safeErrorMessage(err) }));
  }
}

/** 라우트 처리기. 응답을 직접 쓴다. */
async function setPermissions(req, res, m) {
  try {
  const body   = await readJsonBody(req);
  const result = await updatePermissions(m[1], body.permissions);
  invalidateKeyState(m[1]);
  noteAdminAudit(res, { detail: { after: { permissions: result.permissions } } });
  res.statusCode = 200;
  res.end(JSON.stringify({ success: true, permissions: result.permissions }));
  } catch (err) {
  if (err.statusCode === 413) {
    res.statusCode = 413;
    res.end(JSON.stringify({ error: "Payload too large" }));
    return true;
  }
  logError("[Admin] updatePermissions error:", err);
  res.statusCode = err.message === "Key not found" ? 404 : 400;
  res.end(JSON.stringify({ error: safeErrorMessage(err) }));
  }
}

/** 라우트 처리기. 응답을 직접 쓴다. */
async function setFragmentLimit(req, res, m) {
  try {
  const body  = await readJsonBody(req);
  const limit = body.fragment_limit;

  if (limit !== null && (!Number.isInteger(limit) || limit < 0)) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: "fragment_limit must be null, 0, or a positive integer" }));
    return true;
  }

  /** 불변조건: 새 상한이 현재 실사용 파편 수보다 작으면 거부 */
  if (limit !== null) {
    const used = await getFragmentCount(m[1]);
    if (limit < used) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "limit_below_usage", used, requested: limit }));
      return true;
    }
  }

  const result = await updateFragmentLimit(m[1], limit);
  noteAdminAudit(res, { detail: { after: { fragment_limit: result.fragment_limit } } });
  res.statusCode = 200;
  res.end(JSON.stringify({ success: true, fragment_limit: result.fragment_limit }));
  } catch (err) {
  if (err.statusCode === 413) {
    res.statusCode = 413;
    res.end(JSON.stringify({ error: "Payload too large" }));
    return true;
  }
  logError("[Admin] updateFragmentLimit error:", err);
  res.statusCode = err.message === "Key not found" ? 404 : 400;
  res.end(JSON.stringify({ error: safeErrorMessage(err) }));
  }
}

/** 라우트 처리기. 응답을 직접 쓴다. */
async function setWorkspace(req, res, m) {
  try {
  const body      = await readJsonBody(req);
  const workspace = body.workspace !== undefined ? body.workspace : undefined;
  if (workspace !== null && workspace !== undefined && typeof workspace !== "string") {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: "workspace must be a string or null" }));
    return true;
  }
  const result = await updateWorkspace(m[1], workspace ?? null);
  noteAdminAudit(res, { detail: { after: { default_workspace: result.default_workspace } } });
  res.statusCode = 200;
  res.end(JSON.stringify({ success: true, default_workspace: result.default_workspace }));
  } catch (err) {
  if (err.statusCode === 413) {
    res.statusCode = 413;
    res.end(JSON.stringify({ error: "Payload too large" }));
    return true;
  }
  logError("[Admin] updateWorkspace error:", err);
  res.statusCode = err.message === "Key not found" ? 404 : 500;
  res.end(JSON.stringify({ error: safeErrorMessage(err) }));
  }
}

/**
 * 라우트 처리기. 응답을 직접 쓴다.
 * 정책 열 변경 직후 해당 열의 조회 캐시를 비워 이 프로세스에서는 다음 요청부터 새 값이 적용된다.
 * 다른 인스턴스는 각 캐시의 30초 만료로 반영된다.
 */
async function setKeyPolicy(req, res, m) {
  try {
  const body   = await readJsonBody(req);
  const patch  = validateKeyPolicyPatch(body, { providerNames: listProviderNames() });
  const result = await updateKeyPolicy(m[1], patch);

  if (Object.hasOwn(patch, "symbolic_hard_gate"))  invalidateHardGateCache(m[1]);
  if (Object.hasOwn(patch, "allowed_workspaces"))  invalidateAllowedWorkspacesCache(m[1]);
  if (Object.hasOwn(patch, "egress_policy"))       invalidateEgressPolicyCache(m[1]);

  const changes = diffKeyPolicy(result.before, result.after);
  logAudit("admin key_policy", {
    success: true,
    details: formatKeyPolicyAuditDetails(m[1], changes),
    actor  : adminAuditActor(req)
  }).catch((auditErr) => logError("[Admin] key policy audit write failed:", auditErr));
  noteAdminAudit(res, { detail: keyPolicyAuditDetail(changes) });

  res.statusCode = 200;
  res.end(JSON.stringify({ success: true, ...result.after }));
  } catch (err) {
  if (err.statusCode === 413) {
    res.statusCode = 413;
    res.end(JSON.stringify({ error: "Payload too large" }));
    return true;
  }
  if (err instanceof KeyPolicyValidationError) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: err.message, field: err.field }));
    return true;
  }
  if (err instanceof SyntaxError) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: "body must be valid JSON" }));
    return true;
  }
  if (err.message === "Key not found" || err.code === "22P02") {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "Key not found" }));
    return true;
  }
  if (err.code === "42703") {
    res.statusCode = 409;
    res.end(JSON.stringify({ error: "policy column is missing: apply migration-055 (npm run migrate)" }));
    return true;
  }
  logError("[Admin] updateKeyPolicy error:", err);
  res.statusCode = 500;
  res.end(JSON.stringify({ error: safeErrorMessage(err) }));
  }
}

/**
 * 수명 변경 라우트의 오류 응답. 본문 크기 413, 본문 JSON과 값 오류 400, 폐기 상태 충돌 409,
 * 없는 키 404, 그 밖은 500이다.
 *
 * @param {import("http").ServerResponse} res
 * @param {unknown} err
 * @param {string} label
 */
function sendKeyLifecycleError(res, err, label) {
  const send = (status, body) => { res.statusCode = status; res.end(JSON.stringify(body)); };
  if (err?.statusCode === 413)                     return send(413, { error: "Payload too large" });
  if (err instanceof SyntaxError)                  return send(400, { error: "body must be valid JSON" });
  if (err instanceof KeyPolicyValidationError)     return send(400, { error: err.message, field: err.field });
  if (err instanceof KeyLifecycleConflictError)    return send(409, { error: err.code });
  if (err?.message === "Key not found" || err?.code === "22P02") return send(404, { error: "Key not found" });
  logError(`[Admin] ${label} error:`, err);
  return send(500, { error: safeErrorMessage(err) });
}

/**
 * 수명 기록의 행위자 표기. 관리 감사 행위자(adminAuditActor)의 주체와 세션 표기다.
 *
 * @param {import("http").IncomingMessage} req
 * @returns {string}
 */
function lifecycleActor(req) {
  const actor = adminAuditActor(req);
  return `${actor.keyId}:${actor.sessionId}`;
}

/**
 * 본문을 읽는다. 빈 본문은 빈 객체다.
 *
 * @param {import("http").IncomingMessage} req
 * @returns {Promise<object>}
 */
async function readOptionalBody(req) {
  const body = await readJsonBody(req);
  return body ?? {};
}

/**
 * 라우트 처리기. 응답을 직접 쓴다.
 * 수명 열(expires_at, description, owner, kind, allowed_cidrs)을 바꾼다. 만료와 허용 대역은 세션 재확인 캐시를 비워
 * 이 프로세스의 열린 세션에 바로 반영한다.
 */
async function patchKeyLifecycle(req, res, m) {
  try {
    const patch  = validateKeyLifecyclePatch(await readJsonBody(req));
    const result = await updateKeyLifecycle(m[1], patch);
    invalidateKeyState(m[1]);
    noteAdminAudit(res, { detail: diffKeyLifecycle(result.before, result.after) });
    res.statusCode = 200;
    res.end(JSON.stringify({ success: true, ...result.after }));
  } catch (err) {
    sendKeyLifecycleError(res, err, "updateKeyLifecycle");
  }
}

/**
 * 라우트 처리기. 응답을 직접 쓴다.
 * 새 원시 키를 만들어 한 번만 돌려준다. 이전 비밀은 graceHours(기본 MEMENTO_KEY_ROTATION_GRACE_HOURS) 동안 유효하다.
 */
async function rotateKey(req, res, m) {
  try {
    const body       = await readOptionalBody(req);
    const graceHours = resolveGraceHours(body.graceHours, keyRotationGraceHours());
    const result     = await rotateApiKey(m[1], { graceHours });
    noteAdminAudit(res, { detail: {
      graceHours,
      keyPrefix         : result.key_prefix,
      previousValidUntil: result.previous_valid_until.toISOString(),
      retiredHashes     : result.retired_secrets
    } });
    res.statusCode = 200;
    res.end(JSON.stringify(result));
  } catch (err) {
    sendKeyLifecycleError(res, err, "rotateApiKey");
  }
}

/**
 * 라우트 처리기. 응답을 직접 쓴다.
 * 키와 모든 비밀을 폐기한다. 세션 재확인 캐시와 정책 캐시를 비우고 이 키의 세션을 닫는다.
 */
async function revokeKey(req, res, m) {
  try {
    const body   = await readOptionalBody(req);
    const reason = validateRevokeReason(body.reason);
    const result = await revokeApiKey(m[1], { reason, actor: lifecycleActor(req) });
    invalidateKeyState(m[1]);
    invalidateHardGateCache(m[1]);
    invalidateAllowedWorkspacesCache(m[1]);
    const closedSessions = await closeSessionsByKeyId(m[1]);
    noteAdminAudit(res, { detail: { reason, revokedHashes: result.revoked_secrets, closedSessions } });
    res.statusCode = 200;
    res.end(JSON.stringify(result));
  } catch (err) {
    sendKeyLifecycleError(res, err, "revokeApiKey");
  }
}

/** 라우트 처리기. 응답을 직접 쓴다. 접근 검토 서명(시각, 행위자)을 남긴다. */
async function reviewKeyAccess(req, res, m) {
  try {
    const result = await recordAccessReview(m[1], lifecycleActor(req));
    noteAdminAudit(res, { detail: {
      reviewedBy        : result.access_reviewed_by,
      previousReviewedAt: result.previous_reviewed_at ? new Date(result.previous_reviewed_at).toISOString() : null
    } });
    res.statusCode = 200;
    res.end(JSON.stringify({ success: true, access_reviewed_at: result.access_reviewed_at, access_reviewed_by: result.access_reviewed_by }));
  } catch (err) {
    sendKeyLifecycleError(res, err, "recordAccessReview");
  }
}

/** 라우트 처리기. 응답을 직접 쓴다. */
async function updateKeyStatus(req, res, m) {
  try {
  const body   = await readJsonBody(req);
  const result = await updateApiKeyStatus(m[1], body.status);
  invalidateKeyState(m[1]);
  noteAdminAudit(res, { detail: { after: { status: result.status } } });
  if (result.status !== "active") await closeSessionsByKeyId(m[1]);
  res.statusCode = 200;
  res.end(JSON.stringify(result));
  } catch (err) {
  if (err.statusCode === 413) {
    res.statusCode = 413;
    res.end(JSON.stringify({ error: "Payload too large" }));
    return true;
  }
  if (err instanceof KeyLifecycleConflictError) {
    res.statusCode = 409;
    res.end(JSON.stringify({ error: err.code }));
    return true;
  }
  logError("[Admin] updateApiKeyStatus error:", err);
  res.statusCode = err.message === "Key not found" ? 404 : 400;
  res.end(JSON.stringify({ error: safeErrorMessage(err) }));
  }
}

/** 라우트 처리기. 응답을 직접 쓴다. */
async function deleteKey(req, res, m) {
  try {
  await deleteApiKey(m[1]);
  invalidateKeyState(m[1]);
  await closeSessionsByKeyId(m[1]);
  res.statusCode = 204;
  res.end();
  } catch (err) {
  if (err instanceof ApiKeyInUseError) {
    res.statusCode = 409;
    res.end(JSON.stringify({
      error           : "key_in_use",
      fragments       : err.fragments,
      reconsolidations: err.reconsolidations
    }));
    return;
  }
  logError("[Admin] deleteApiKey error:", err);
  res.statusCode = err.message === "Key not found" ? 404 : 500;
  res.end(JSON.stringify({ error: safeErrorMessage(err) }));
  }
}

/** 라우트 처리기. 응답을 직접 쓴다. */
async function listGroups(req, res) {
  try {
  const groups = await listKeyGroups();
  res.statusCode = 200;
  res.end(JSON.stringify(groups));
  } catch (err) {
  logError("[Admin] listKeyGroups error:", err);
  res.statusCode = 500;
  res.end(JSON.stringify({ error: safeErrorMessage(err) }));
  }
}

/** 라우트 처리기. 응답을 직접 쓴다. */
async function createGroup(req, res) {
  try {
  const body = await readJsonBody(req);
  if (!body.name || typeof body.name !== "string") {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: "name is required" }));
    return true;
  }
  const group = await createKeyGroup({
    name       : body.name.trim(),
    description: body.description || null
  });
  noteAdminAudit(res, { targetId: group.id });
  res.statusCode = 201;
  res.end(JSON.stringify(group));
  } catch (err) {
  logError("[Admin] createKeyGroup error:", err);
  res.statusCode = err.message.includes("unique") ? 409 : 500;
  res.end(JSON.stringify({ error: safeErrorMessage(err) }));
  }
}

/** 라우트 처리기. 응답을 직접 쓴다. */
async function removeMember(req, res, m) {
  try {
  const result = await removeKeyFromGroup(m[2], m[1]);
  noteAdminAudit(res, { detail: { memberKeyId: m[2] } });
  res.statusCode = 200;
  res.end(JSON.stringify(result));
  } catch (err) {
  res.statusCode = 500;
  res.end(JSON.stringify({ error: safeErrorMessage(err) }));
  }
}

/** 라우트 처리기. 응답을 직접 쓴다. */
async function deleteGroup(req, res, m) {
  try {
  await deleteKeyGroup(m[1]);
  res.statusCode = 200;
  res.end(JSON.stringify({ deleted: true }));
  } catch (err) {
  logError("[Admin] deleteKeyGroup error:", err);
  res.statusCode = err.message === "Group not found" ? 404 : 500;
  res.end(JSON.stringify({ error: safeErrorMessage(err) }));
  }
}

/** 라우트 처리기. 응답을 직접 쓴다. */
async function listGroupMembers(req, res, m) {
  try {
    const members = await getGroupMembers(m[1]);
    res.statusCode = 200;
    res.end(JSON.stringify(members));
  } catch (err) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: safeErrorMessage(err) }));
  }
}

/** 라우트 처리기. 응답을 직접 쓴다. */
async function addGroupMember(req, res, m) {
  try {
    const body = await readJsonBody(req);
    if (!body.key_id) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "key_id is required" }));
      return true;
    }
    const result = await addKeyToGroup(body.key_id, m[1]);
    noteAdminAudit(res, { detail: { memberKeyId: String(body.key_id) } });
    res.statusCode = 200;
    res.end(JSON.stringify(result));
  } catch (err) {
    res.statusCode = err.message.includes("violates") ? 404 : 500;
    res.end(JSON.stringify({ error: safeErrorMessage(err) }));
  }
}

/** 경로 일치 판정기. 리터럴 비교와 정규식 두 형태를 같은 모양으로 다룬다. */
const exact = (path) => (pathname) => (pathname === path ? [] : null);
const regex = (re)   => (pathname) => pathname.match(re);

/**
 * 라우트 표.
 *
 * 종전에는 메서드와 경로 판정이 본문과 뒤섞인 긴 if 사슬이었다. 라우트를 더할
 * 때마다 사슬 어디에 끼울지 판단해야 했고, 앞선 분기가 먼저 잡아채는 순서
 * 의존이 눈에 보이지 않았다. 판정을 표로 빼면 순서가 곧 표의 순서가 된다.
 *
 * 구체 경로가 변수 경로보다 앞에 온다. `/keys/:id`가 `/keys/:id/stats`를 먼저
 * 잡으면 통계 조회가 닿지 않는다.
 */
const ROUTES = [
  { method: "GET",    match: exact(`${ADMIN_BASE}/keys`),                                        handler: listKeys },
  { method: "GET",    match: regex(new RegExp(`^${ADMIN_BASE}/keys/([^/]+)/stats$`)),            handler: keyStats },
  { method: "POST",   match: exact(`${ADMIN_BASE}/keys`),                                        handler: createKey },
  { method: "PUT",    match: regex(new RegExp(`^${ADMIN_BASE}/keys/([^/]+)/daily-limit$`)),      handler: setDailyLimit },
  { method: "PUT",    match: regex(new RegExp(`^${ADMIN_BASE}/keys/([^/]+)/permissions$`)),      handler: setPermissions },
  { method: "PUT",    match: regex(new RegExp(`^${ADMIN_BASE}/keys/([^/]+)/fragment-limit$`)),   handler: setFragmentLimit },
  { method: "PATCH",  match: regex(new RegExp(`^${ADMIN_BASE}/keys/([^/]+)/workspace$`)),        handler: setWorkspace },
  { method: "PATCH",  match: regex(new RegExp(`^${ADMIN_BASE}/keys/([^/]+)/policy$`)),           handler: setKeyPolicy },
  { method: "POST",   match: regex(new RegExp(`^${ADMIN_BASE}/keys/([^/]+)/rotate$`)),           handler: rotateKey },
  { method: "POST",   match: regex(new RegExp(`^${ADMIN_BASE}/keys/([^/]+)/revoke$`)),           handler: revokeKey },
  { method: "POST",   match: regex(new RegExp(`^${ADMIN_BASE}/keys/([^/]+)/access-review$`)),    handler: reviewKeyAccess },
  { method: "PATCH",  match: regex(new RegExp(`^${ADMIN_BASE}/keys/([^/]+)$`)),                  handler: patchKeyLifecycle },
  { method: "PUT",    match: regex(new RegExp(`^${ADMIN_BASE}/keys/([^/]+)$`)),                  handler: updateKeyStatus },
  { method: "DELETE", match: regex(new RegExp(`^${ADMIN_BASE}/keys/([^/]+)$`)),                  handler: deleteKey },
  { method: "GET",    match: exact(`${ADMIN_BASE}/groups`),                                      handler: listGroups },
  { method: "POST",   match: exact(`${ADMIN_BASE}/groups`),                                      handler: createGroup },
  { method: "GET",    match: regex(new RegExp(`^${ADMIN_BASE}/groups/([^/]+)/members$`)),        handler: listGroupMembers },
  { method: "POST",   match: regex(new RegExp(`^${ADMIN_BASE}/groups/([^/]+)/members$`)),        handler: addGroupMember },
  { method: "DELETE", match: regex(new RegExp(`^${ADMIN_BASE}/groups/([^/]+)/members/([^/]+)$`)), handler: removeMember },
  { method: "DELETE", match: regex(new RegExp(`^${ADMIN_BASE}/groups/([^/]+)$`)),                handler: deleteGroup },
];

/**
 * /keys 및 /groups 관련 라우트를 표에서 찾아 위임한다.
 *
 * @returns {Promise<boolean>} 처리 여부. false면 호출자가 다음 라우트를 탐색한다.
 */
export async function handleKeys(req, res, url) {
  for (const route of ROUTES) {
    if (req.method !== route.method) continue;
    const m = route.match(url.pathname);
    if (!m) continue;
    await route.handler(req, res, m);
    return true;
  }
  return false;
}
