/**
 * Admin: 키·workspace별 파편 보존 정책 저장소(key_retention_policies, migration-078)
 *
 * 작성자: 최진호
 * 작성일: 2026-11-04
 *
 * 정책 하나는 (키, workspace 또는 키 전체)에 거는 보존 기간과 자동 정리 설정이다(migration-078, migration-084).
 *   보존 기간   max_age_days(일수) 또는 no_expiry(만료 없음). 둘 다 없으면 다른 행(키 전체)의 기간을 물려받는다.
 *               삭제는 정리 주기의 retention_expire 단계(lib/memory/consolidate/RetentionGC.js)가 한다.
 *   자동 정리   auto_lifecycle=FALSE이면 그 범위에서 자동 판단으로 지우거나 닫지 않는다(RetentionGuard).
 *               다시 켜면 auto_resume_at까지는 꺼진 것으로 다룬다.
 * 일수만 다루는 기존 API(listRetentionPolicies, setRetentionPolicy)는 동작이 그대로다. 목록에는 일수가 있는 행만
 * 나오고, 일수를 지우면(null) 다른 설정이 없는 행만 지운다. 새 설정은 listRetentionScopes, setRetentionScope로 다룬다.
 */

import { getPrimaryPool } from "../tools/db.js";
import { logWarn }        from "../logger.js";
import { SCHEMA }         from "../memory/schema.js";
import { retentionModeSetting } from "../config.js";
import { GC_CANDIDATE_FROM, gcCandidateParams, gcCandidateExtraSql, permanentDemoteSql } from "../memory/consolidate/FragmentGC.js";
import { RETENTION_CANDIDATE_FROM } from "../memory/consolidate/RetentionGC.js";
import { countLiveFragments } from "../memory/read/quotaQueries.js";
import { queryScoped, ROW_SUBJECT } from "../tools/row-scope.js";

/** 보존 일수 범위. 표의 CHECK와 같다. */
export const RETENTION_MAX_AGE_DAYS = Object.freeze({ min: 1, max: 36_500 });

/** 입력 오류 */
export class RetentionPolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = "RetentionPolicyError";
  }
}

/**
 * 입력 { workspace, max_age_days }를 검사한다. max_age_days가 null이면 정책을 지우라는 뜻이다.
 *
 * @param {unknown} body
 * @returns {{ workspace: string|null, maxAgeDays: number|null }}
 */
export function normalizeRetentionInput(body) {
  if (!body || typeof body !== "object") throw new RetentionPolicyError("body must be an object");
  const raw = body.workspace ?? null;
  if (raw !== null && (typeof raw !== "string" || raw.trim() === "" || raw.length > 128)) {
    throw new RetentionPolicyError("workspace must be null (all workspaces) or a 1-128 character name");
  }
  const days = body.max_age_days;
  if (days !== null && (!Number.isInteger(days) || days < RETENTION_MAX_AGE_DAYS.min || days > RETENTION_MAX_AGE_DAYS.max)) {
    throw new RetentionPolicyError(`max_age_days must be null (remove) or an integer ${RETENTION_MAX_AGE_DAYS.min}-${RETENTION_MAX_AGE_DAYS.max}`);
  }
  return { workspace: raw === null ? null : raw.trim(), maxAgeDays: days };
}

/**
 * 키의 보존 정책 목록. 키 전체 정책이 먼저다.
 *
 * @param {string} keyId
 * @returns {Promise<Array<{ workspace: string|null, max_age_days: number, updated_at: string }>>}
 */
export async function listRetentionPolicies(keyId) {
  const { rows } = await getPrimaryPool().query(
    `SELECT workspace, max_age_days, updated_at FROM ${SCHEMA}.key_retention_policies
      WHERE key_id = $1 AND max_age_days IS NOT NULL ORDER BY workspace NULLS FIRST`,
    [keyId]
  );
  return rows;
}

/**
 * 보존 일수를 넣거나 바꾼다. maxAgeDays가 null이면 일수를 지운다. 그 범위에 다른 설정(no_expiry, 자동 정리)이
 * 없으면 행을 지우고, 있으면 일수만 비운다. 일수를 넣으면 no_expiry는 꺼진다. 바뀌기 전 일수(없으면 null)를 돌려준다.
 *
 * @param {string} keyId
 * @param {{ workspace: string|null, maxAgeDays: number|null }} input
 * @returns {Promise<{ workspace: string|null, previous: number|null, max_age_days: number|null }>}
 */
export async function setRetentionPolicy(keyId, { workspace, maxAgeDays }) {
  const pool = getPrimaryPool();
  const { rows: [before] } = await pool.query(
    `SELECT max_age_days FROM ${SCHEMA}.key_retention_policies
      WHERE key_id = $1 AND COALESCE(workspace, '') = COALESCE($2::text, '')`,
    [keyId, workspace]
  );
  if (maxAgeDays === null) {
    await pool.query(
      `DELETE FROM ${SCHEMA}.key_retention_policies WHERE key_id = $1 AND COALESCE(workspace, '') = COALESCE($2::text, '')
          AND NOT no_expiry AND auto_lifecycle AND auto_resume_at IS NULL`,
      [keyId, workspace]
    );
    await pool.query(
      `UPDATE ${SCHEMA}.key_retention_policies SET max_age_days = NULL, updated_at = NOW()
        WHERE key_id = $1 AND COALESCE(workspace, '') = COALESCE($2::text, '')`,
      [keyId, workspace]
    );
  } else {
    await pool.query(
      `INSERT INTO ${SCHEMA}.key_retention_policies (key_id, workspace, max_age_days)
       VALUES ($1, $2, $3)
       ON CONFLICT (key_id, COALESCE(workspace, ''))
       DO UPDATE SET max_age_days = EXCLUDED.max_age_days, no_expiry = FALSE, updated_at = NOW()`,
      [keyId, workspace, maxAgeDays]
    );
  }
  return { workspace, previous: before?.max_age_days ?? null, max_age_days: maxAgeDays };
}

/** 자동 정리를 다시 켤 때 기다리는 일수 범위와 기본값 */
export const RESUME_AFTER_DAYS = Object.freeze({ min: 0, max: 90, default: 7 });

/**
 * 범위 설정 입력 { workspace, autoLifecycle?, noExpiry?, resumeAfterDays? }을 검사한다. 바꿀 항목이 하나는 있어야 한다.
 *
 * @param {unknown} body
 * @returns {{ workspace: string|null, autoLifecycle?: boolean, noExpiry?: boolean, resumeAfterDays: number }}
 */
export function normalizeScopeInput(body) {
  if (!body || typeof body !== "object") throw new RetentionPolicyError("body must be an object");
  const { workspace } = normalizeRetentionInput({ workspace: body.workspace ?? null, max_age_days: null });
  const out = { workspace, resumeAfterDays: RESUME_AFTER_DAYS.default };
  if (body.autoLifecycle !== undefined) {
    if (typeof body.autoLifecycle !== "boolean") throw new RetentionPolicyError("autoLifecycle must be a boolean");
    out.autoLifecycle = body.autoLifecycle;
  }
  if (body.noExpiry !== undefined) {
    if (typeof body.noExpiry !== "boolean") throw new RetentionPolicyError("noExpiry must be a boolean");
    out.noExpiry = body.noExpiry;
  }
  if (body.resumeAfterDays !== undefined) {
    const d = body.resumeAfterDays;
    if (!Number.isInteger(d) || d < RESUME_AFTER_DAYS.min || d > RESUME_AFTER_DAYS.max) {
      throw new RetentionPolicyError(`resumeAfterDays must be an integer ${RESUME_AFTER_DAYS.min}-${RESUME_AFTER_DAYS.max}`);
    }
    out.resumeAfterDays = d;
  }
  if (out.autoLifecycle === undefined && out.noExpiry === undefined) {
    throw new RetentionPolicyError("autoLifecycle or noExpiry is required");
  }
  return out;
}

/** 정책 행을 응답 모양으로 바꾼다. */
function scopeRow(r) {
  if (!r) return null;
  return {
    workspace     : r.workspace,
    max_age_days  : r.max_age_days,
    no_expiry     : r.no_expiry,
    auto_lifecycle: r.auto_lifecycle,
    auto_resume_at: r.auto_resume_at ? new Date(r.auto_resume_at).toISOString() : null,
    updated_at    : r.updated_at ? new Date(r.updated_at).toISOString() : null
  };
}

/** 지금 자동 정리가 꺼져 있는 행인가(재개 대기 포함) */
function rowIsManual(r, now = Date.now()) {
  if (!r) return false;
  if (r.auto_lifecycle === false) return true;
  return r.auto_resume_at != null && new Date(r.auto_resume_at).getTime() > now;
}

/** 행 하나가 정한 보존 기간. null이면 정하지 않음, "none"이면 만료 없음, 숫자는 일수 */
function rowExpiry(r) {
  if (!r) return null;
  if (r.no_expiry) return "none";
  return r.max_age_days ?? null;
}

/**
 * 범위 하나에 실제로 적용되는 모드와 기간, 그 출처를 계산한다.
 *
 * @param {Object|null} keyRow  키 전체 행
 * @param {Object|null} wsRow   workspace 행(키 전체 범위면 null)
 * @param {{ effective: string, mode: string, pending: boolean, autoAfter: (number|null) }} global
 */
function effectiveScope(keyRow, wsRow, global) {
  let mode = "auto", modeSource = null;
  if (global.effective === "manual")  { mode = "manual"; modeSource = "global"; }
  else if (rowIsManual(keyRow))       { mode = "manual"; modeSource = "key"; }
  else if (rowIsManual(wsRow))        { mode = "manual"; modeSource = "workspace"; }
  const wsExpiry  = rowExpiry(wsRow);
  const keyExpiry = rowExpiry(keyRow);
  const expiry    = wsExpiry ?? keyExpiry;
  const expirySource = wsExpiry !== null ? "workspace" : (keyExpiry !== null ? "key" : null);
  return {
    mode, modeSource,
    expiry: expiry === null ? null : expiry,
    expirySource
  };
}

/**
 * 키의 workspace별 살아 있는 파편 수(많은 순 50개). 파편 표는 행 수준 보안이 걸릴 수 있어 system 주체로 센다.
 *
 * @param {Object} pool
 * @param {string} keyId
 * @returns {Promise<Array<{ workspace: string|null, fragments: number }>>}
 */
async function workspaceFragmentCounts(pool, keyId) {
  const { rows } = await queryScoped(pool,
    `SELECT workspace, count(*)::int AS fragments FROM ${SCHEMA}.fragments
      WHERE key_id = $1 AND valid_to IS NULL GROUP BY workspace ORDER BY 2 DESC LIMIT 50`, [keyId], ROW_SUBJECT.SYSTEM);
  return rows;
}

/** 키의 살아 있는 파편 수(할당량 사용량). 행 수준 보안이 걸려도 키 전체를 세도록 system 주체로 보낸다. */
function liveFragmentCount(pool, keyId) {
  return countLiveFragments({ query: (sql, params) => queryScoped(pool, sql, params, ROW_SUBJECT.SYSTEM) }, keyId);
}

/**
 * 키의 범위 설정 전체. 행마다 저장한 값과 실제 적용 값, 이 키가 쓰는 workspace 목록(파편 수 순 상위 50개),
 * 할당량 사용량, 전역 설정을 돌려준다.
 *
 * @param {string} keyId
 * @param {{ pool?: Object }} [deps]
 */
export async function listRetentionScopes(keyId, { pool = getPrimaryPool() } = {}) {
  const now    = Date.now();
  const global = retentionModeSetting(now);
  const { rows } = await pool.query(
    `SELECT workspace, max_age_days, no_expiry, auto_lifecycle, auto_resume_at, updated_at
       FROM ${SCHEMA}.key_retention_policies WHERE key_id = $1 ORDER BY workspace NULLS FIRST`, [keyId]);
  const keyRow = rows.find(r => r.workspace === null) ?? null;
  const wsRows = await workspaceFragmentCounts(pool, keyId);
  const { rows: [quotaRow] } = await pool.query(`SELECT fragment_limit FROM ${SCHEMA}.api_keys WHERE id = $1`, [keyId]);
  return {
    keyId,
    global: {
      mode     : global.mode,
      effective: global.effective,
      pending  : global.pending,
      autoAfter: global.autoAfter !== null ? new Date(global.autoAfter).toISOString() : null
    },
    scopes: rows.map(r => ({
      ...scopeRow(r),
      effective: effectiveScope(keyRow, r.workspace === null ? null : r, global)
    })),
    keyEffective: effectiveScope(keyRow, null, global),
    workspaces  : wsRows.map(w => ({
      workspace: w.workspace,
      fragments: w.fragments,
      effective: effectiveScope(keyRow, rows.find(r => r.workspace !== null && r.workspace === w.workspace) ?? null, global)
    })),
    quota: { limit: quotaRow?.fragment_limit ?? null, used: await liveFragmentCount(pool, keyId) }
  };
}

/**
 * 범위 하나의 자동 정리와 만료 없음 설정을 바꾼다. 자동 정리를 끄면 재개 시각을 지우고, 꺼진 범위를 다시 켜면
 * resumeAfterDays일 뒤로 재개 시각을 둔다(0이면 바로 켠다). 바뀐 뒤 아무 효과가 없는 행은 지운다.
 *
 * @param {string} keyId
 * @param {ReturnType<typeof normalizeScopeInput>} input
 * @param {{ pool?: Object }} [deps]
 * @returns {Promise<{ workspace: string|null, before: Object|null, after: Object|null }>}
 */
export async function setRetentionScope(keyId, input, { pool = getPrimaryPool() } = {}) {
  const { workspace, autoLifecycle, noExpiry, resumeAfterDays } = input;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: [before] } = await client.query(
      `SELECT workspace, max_age_days, no_expiry, auto_lifecycle, auto_resume_at, updated_at
         FROM ${SCHEMA}.key_retention_policies
        WHERE key_id = $1 AND COALESCE(workspace, '') = COALESCE($2::text, '') FOR UPDATE`, [keyId, workspace]);
    const cur = before ?? { max_age_days: null, no_expiry: false, auto_lifecycle: true, auto_resume_at: null };
    const next = { ...cur };
    if (noExpiry !== undefined) {
      next.no_expiry = noExpiry;
      if (noExpiry) next.max_age_days = null;
    }
    if (autoLifecycle === false) {
      next.auto_lifecycle = false;
      next.auto_resume_at = null;
    } else if (autoLifecycle === true && rowIsManual(cur)) {
      next.auto_lifecycle = true;
      next.auto_resume_at = resumeAfterDays > 0 ? new Date(Date.now() + resumeAfterDays * 86_400_000) : null;
    }
    const empty = next.max_age_days === null && !next.no_expiry && next.auto_lifecycle && next.auto_resume_at === null;
    let after = null;
    if (empty) {
      await client.query(
        `DELETE FROM ${SCHEMA}.key_retention_policies WHERE key_id = $1 AND COALESCE(workspace, '') = COALESCE($2::text, '')`,
        [keyId, workspace]);
    } else {
      const { rows: [row] } = await client.query(
        `INSERT INTO ${SCHEMA}.key_retention_policies (key_id, workspace, max_age_days, no_expiry, auto_lifecycle, auto_resume_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (key_id, COALESCE(workspace, ''))
         DO UPDATE SET max_age_days = EXCLUDED.max_age_days, no_expiry = EXCLUDED.no_expiry,
                       auto_lifecycle = EXCLUDED.auto_lifecycle, auto_resume_at = EXCLUDED.auto_resume_at, updated_at = NOW()
         RETURNING workspace, max_age_days, no_expiry, auto_lifecycle, auto_resume_at, updated_at`,
        [keyId, workspace, next.max_age_days, next.no_expiry, next.auto_lifecycle, next.auto_resume_at]);
      after = row;
    }
    await client.query("COMMIT");
    return { workspace, before: scopeRow(before ?? null), after: scopeRow(after) };
  } catch (err) {
    await client.query("ROLLBACK").catch((rollbackErr) => logWarn(`[RetentionPolicy] scope rollback failed: ${rollbackErr.message}`));
    throw err;
  } finally {
    client.release();
  }
}

/** 정책 행이 없는 범위의 값 */
const NO_POLICY_ROW = Object.freeze({ max_age_days: null, no_expiry: false, auto_lifecycle: true, auto_resume_at: null });

/**
 * 범위 설정에서 바뀐 필드만 before와 after에 담는다. 감사 화면이 detail을 140자에서 자르므로 길이를 줄인다.
 * 행이 없던(또는 지워진) 쪽은 정책 행이 없는 범위의 값으로 비교한다.
 *
 * @param {Object|null} before
 * @param {Object|null} after
 * @returns {{ before: Object, after: Object }}
 */
export function changedScopeFields(before, after) {
  const b = {}, a = {};
  for (const k of Object.keys(NO_POLICY_ROW)) {
    const bv = (before ?? NO_POLICY_ROW)[k] ?? null, av = (after ?? NO_POLICY_ROW)[k] ?? null;
    if (bv !== av) { b[k] = bv; a[k] = av; }
  }
  return { before: b, after: a };
}

/** 범위 조건(파편 별칭 f). workspace가 null이면 키 전체다. 매개변수는 $1 키, $2 workspace(키 전체면 쓰지 않음) */
function scopeFilter(workspace) {
  return workspace === null ? "f.key_id = $1" : "f.key_id = $1 AND f.workspace = $2";
}

/**
 * 범위 하나에서 자동 정리를 켜면 다음 주기에 손댈 파편 수를 센다. 아무것도 바꾸지 않는다. 의미 중복 병합, 대체 판정,
 * 분할, 모순 해소는 임베딩 비교나 LLM 판정이 있어야 대상이 정해지므로 세지 않고 notCounted에 적는다.
 * 보존 기간 만료(retentionExpire)는 모드와 무관하게 지금 정책으로 지워질 수다.
 *
 * @param {string} keyId
 * @param {string|null} workspace
 * @param {{ pool?: Object }} [deps]
 */
export async function previewRetentionScope(keyId, workspace, { pool = getPrimaryPool() } = {}) {
  const where  = scopeFilter(workspace);
  const scope  = workspace === null ? [keyId] : [keyId, workspace];
  const n      = scope.length;
  const gc     = gcCandidateParams().map((v, i) => ({ v, i }));
  /** GC_CANDIDATE_FROM의 $1~$7을 범위 매개변수 뒤로 민다 */
  const gcFrom = GC_CANDIDATE_FROM.replace(/\$(\d+)/g, (_, d) => `$${Number(d) + n}`);
  /** 파편 표는 행 수준 보안이 걸릴 수 있어 system 주체로 센다(lib/tools/row-scope.js). */
  const count  = async (sql, params) => (await queryScoped(pool, sql, params, ROW_SUBJECT.SYSTEM)).rows[0]?.n ?? 0;
  const [expiredDelete, permanentDemote, reflectionPurge, reviewExpire, exactDuplicates, retentionExpire] = await Promise.all([
    /** 만료 삭제와 permanent 강등은 정리 주기와 같은 조건 함수(FragmentGC)로 센다. */
    count(`SELECT count(*)::int AS n ${gcFrom} AND ${where}${gcCandidateExtraSql()}`, [...scope, ...gc.map(x => x.v)]),
    count(`SELECT count(*)::int AS n FROM ${SCHEMA}.fragments f WHERE ${where} AND ${permanentDemoteSql("f")}`, scope),
    count(`SELECT count(*)::int AS n FROM ${SCHEMA}.fragments f WHERE ${where} AND f.topic = 'session_reflect'
             AND f.importance < 0.3 AND f.created_at < NOW() - INTERVAL '30 days' AND f.is_anchor = FALSE
             AND f.ttl_tier <> 'permanent'`, scope),
    count(`SELECT count(*)::int AS n FROM ${SCHEMA}.fragments f WHERE ${where} AND f.review_state = 'pending'
             AND f.valid_to IS NULL AND f.created_at < NOW() - INTERVAL '30 days'`, scope),
    count(`SELECT COALESCE(sum(c - 1), 0)::int AS n FROM (
             SELECT count(*) AS c FROM ${SCHEMA}.fragments f WHERE ${where} AND f.valid_to IS NULL
              GROUP BY f.workspace, f.content_hash HAVING count(*) > 1) d`, scope),
    count(`SELECT count(*)::int AS n ${RETENTION_CANDIDATE_FROM} AND ${where}`, scope)
  ]);
  return {
    keyId, workspace,
    counts: { expiredDelete, permanentDemote, reflectionPurge, reviewExpire, exactDuplicates, retentionExpire },
    notCounted: ["semantic_dedup", "detect_supersessions", "split_long_fragments", "contradiction_resolution"]
  };
}

/**
 * 자동 정리가 꺼져 있거나 재개를 기다리거나 만료 없음이 걸린 범위를 모든 키에서 모은다.
 *
 * @param {{ pool?: Object, limit?: number }} [deps]
 */
export async function listAllRetentionScopes({ pool = getPrimaryPool(), limit = 500 } = {}) {
  const { rows } = await pool.query(
    `SELECT p.key_id, k.name AS key_name, p.workspace, p.max_age_days, p.no_expiry, p.auto_lifecycle, p.auto_resume_at, p.updated_at
       FROM ${SCHEMA}.key_retention_policies p
       JOIN ${SCHEMA}.api_keys k ON k.id = p.key_id
      WHERE p.auto_lifecycle = FALSE OR p.no_expiry OR p.auto_resume_at IS NOT NULL
      ORDER BY k.name, p.workspace NULLS FIRST
      LIMIT $1`, [limit]);
  const g = retentionModeSetting();
  return {
    global: { mode: g.mode, effective: g.effective, pending: g.pending, autoAfter: g.autoAfter !== null ? new Date(g.autoAfter).toISOString() : null },
    scopes: rows.map(r => ({ key_id: r.key_id, key_name: r.key_name, ...scopeRow(r), manual: rowIsManual(r) }))
  };
}

/**
 * workspace 병합 때 정책 행을 옮긴다. 대상에 행이 없으면 그대로 옮기고, 있으면 보존 쪽이 이기도록 합친다.
 * 자동 정리는 하나라도 꺼져 있으면 꺼짐, 재개 시각은 늦은 쪽, 만료 없음은 하나라도 켜져 있으면 켜짐, 일수는 긴 쪽이다.
 * 같은 트랜잭션의 client로 부른다. 옮긴 행이 없으면 null을 돌려준다.
 *
 * @param {{ query: Function }} client
 * @param {string} keyId
 * @param {string} from
 * @param {string} to
 * @param {{ apply?: boolean }} [opts]
 * @returns {Promise<{ from: Object, to: (Object|null), result: Object }|null>}
 */
export async function mergeRetentionPolicyRows(client, keyId, from, to, { apply = false } = {}) {
  const sel = `SELECT workspace, max_age_days, no_expiry, auto_lifecycle, auto_resume_at, updated_at
                 FROM ${SCHEMA}.key_retention_policies WHERE key_id = $1 AND workspace = $2`;
  const { rows: [src] } = await client.query(sel, [keyId, from]).catch((err) => {
    if (err?.code === "42P01" || err?.code === "42703") return { rows: [] };
    throw err;
  });
  if (!src) return null;
  const { rows: [dst] } = await client.query(sel, [keyId, to]);
  const later = (a, b) => (!a ? b : !b ? a : (new Date(a) > new Date(b) ? a : b));
  const result = dst ? {
    workspace     : to,
    no_expiry     : src.no_expiry || dst.no_expiry,
    max_age_days  : (src.no_expiry || dst.no_expiry) ? null
      : (src.max_age_days === null ? dst.max_age_days : dst.max_age_days === null ? src.max_age_days : Math.max(src.max_age_days, dst.max_age_days)),
    auto_lifecycle: src.auto_lifecycle && dst.auto_lifecycle,
    auto_resume_at: (src.auto_lifecycle && dst.auto_lifecycle) ? later(src.auto_resume_at, dst.auto_resume_at) : null
  } : { ...src, workspace: to };
  if (apply) {
    await client.query(`DELETE FROM ${SCHEMA}.key_retention_policies WHERE key_id = $1 AND workspace = $2`, [keyId, from]);
    await client.query(
      `INSERT INTO ${SCHEMA}.key_retention_policies (key_id, workspace, max_age_days, no_expiry, auto_lifecycle, auto_resume_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (key_id, COALESCE(workspace, ''))
       DO UPDATE SET max_age_days = EXCLUDED.max_age_days, no_expiry = EXCLUDED.no_expiry,
                     auto_lifecycle = EXCLUDED.auto_lifecycle, auto_resume_at = EXCLUDED.auto_resume_at, updated_at = NOW()`,
      [keyId, to, result.max_age_days, result.no_expiry, result.auto_lifecycle, result.auto_resume_at]);
  }
  return { from: scopeRow(src), to: scopeRow(dst ?? null), result: scopeRow({ ...result, updated_at: null }) };
}
