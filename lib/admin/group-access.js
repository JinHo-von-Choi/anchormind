/**
 * 키 그룹 접근 판정과 멤버 권한 저장
 *
 * 작성자: 최진호
 * 작성일: 2026-11-04
 *
 * 요청 키가 읽을 수 있는 키 목록(groupKeyIds)과 다른 멤버 파편에 대한 쓰기 권한(groupGrants)을 한 질의로 만든다.
 * 권한 규칙은 lib/memory/groupGrants.js에 있다. 멤버 권한 열(migration-073)이 아직 없는 DB에서는 모든 멤버를
 * 기본 권한(read, share, link)으로 보고 판정한다. 이 열이 생기기 전의 그룹 동작과 같다.
 */

import { getPrimaryPool } from "../tools/db.js";
import { logWarn }        from "../logger.js";
import { SCHEMA }         from "../memory/schema.js";
import {
  groupAccessFromRows, normalizeMemberPermissions, normalizeSharedWorkspaces, DEFAULT_MEMBER_PERMISSIONS, GroupPermissionError
} from "../memory/groupGrants.js";

/** PostgreSQL undefined_column */
const UNDEFINED_COLUMN = "42703";

let missingColumnWarned = false;

/**
 * 같은 그룹의 다른 멤버별 판정을 (멤버, 그룹)마다 한 행으로 돌려준다. m1이 요청 키, m2가 대상 키다. 한 그룹에서
 * m1의 권한과 read, m2의 share가 모두 있어야 그 권한이 성립한다. 여러 그룹의 판정과 공유 workspace는
 * groupAccessFromRows가 합친다.
 */
const ACCESS_SQL = `
  SELECT m2.key_id,
         ('read'   = ANY(m1.permissions) AND 'share' = ANY(m2.permissions)) AS can_read,
         ('link'   = ANY(m1.permissions) AND 'read' = ANY(m1.permissions) AND 'share' = ANY(m2.permissions)) AS can_link,
         ('amend'  = ANY(m1.permissions) AND 'read' = ANY(m1.permissions) AND 'share' = ANY(m2.permissions)) AS can_amend,
         ('forget' = ANY(m1.permissions) AND 'read' = ANY(m1.permissions) AND 'share' = ANY(m2.permissions)) AS can_forget,
         m2.shared_workspaces
    FROM ${SCHEMA}.api_key_group_members m1
    JOIN ${SCHEMA}.api_key_group_members m2 ON m2.group_id = m1.group_id AND m2.key_id <> m1.key_id
   WHERE m1.key_id = $1
   ORDER BY m2.key_id`;

/** 권한 열이 없을 때의 판정. 모든 멤버가 기본 권한이고 모든 workspace를 공유한다. */
const LEGACY_ACCESS_SQL = `
  SELECT DISTINCT m2.key_id, true AS can_read, true AS can_link, false AS can_amend, false AS can_forget,
         NULL::text[] AS shared_workspaces
    FROM ${SCHEMA}.api_key_group_members m1
    JOIN ${SCHEMA}.api_key_group_members m2 ON m2.group_id = m1.group_id AND m2.key_id <> m1.key_id
   WHERE m1.key_id = $1
   ORDER BY m2.key_id`;

/**
 * 권한 열이 없어서 난 오류인지 본다.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
function isMissingPermissionsColumn(err) {
  return err?.code === UNDEFINED_COLUMN && /permissions|updated_at|shared_workspaces/.test(String(err?.message ?? ""));
}

/**
 * 권한 열이 없으면 legacy 질의로 다시 읽는다.
 *
 * @param {import("pg").Pool|import("pg").PoolClient} db
 * @param {string} sql
 * @param {string} legacySql
 * @param {Array} params
 */
async function queryWithPermissionsFallback(db, sql, legacySql, params) {
  try {
    return await db.query(sql, params);
  } catch (err) {
    if (!isMissingPermissionsColumn(err)) throw err;
    if (!missingColumnWarned) {
      missingColumnWarned = true;
      logWarn("[GroupAccess] api_key_group_members.permissions not found (migration 073 not applied); every member uses read, share, link");
    }
    return db.query(legacySql, params);
  }
}

/**
 * 요청 키의 그룹 접근. 키가 없으면 null이다. 그룹에 속하지 않으면 자기 키만 읽고 쓰기 권한이 없다.
 *
 * @param {string|null} keyId
 * @param {import("pg").Pool} [db]
 * @returns {Promise<{ groupKeyIds: string[], groupGrants: { link: string[], amend: string[], forget: string[] } }|null>}
 */
export async function getGroupAccess(keyId, db = getPrimaryPool()) {
  if (!keyId) return null;
  const { rows } = await queryWithPermissionsFallback(db, ACCESS_SQL, LEGACY_ACCESS_SQL, [keyId]);
  return groupAccessFromRows(keyId, rows);
}

/**
 * 그룹 멤버 목록. 권한 열이 없으면 모든 멤버를 기본 권한으로 돌려준다.
 *
 * @param {string} groupId
 * @returns {Promise<Array<object>>}
 */
export async function listGroupMembersWithPermissions(groupId) {
  const select = (perms) => `
    SELECT k.id, k.name, k.key_prefix, k.status, m.joined_at, ${perms}
      FROM ${SCHEMA}.api_key_group_members m
      JOIN ${SCHEMA}.api_keys k ON k.id = m.key_id
     WHERE m.group_id = $1
     ORDER BY m.joined_at ASC`;
  const { rows } = await queryWithPermissionsFallback(
    getPrimaryPool(),
    select("m.permissions, m.shared_workspaces, m.updated_at"),
    select(`ARRAY['${DEFAULT_MEMBER_PERMISSIONS.join("','")}']::text[] AS permissions, NULL::text[] AS shared_workspaces, NULL::timestamptz AS updated_at`),
    [groupId]
  );
  return rows;
}

/**
 * 그룹의 멤버 키 id 목록. 멤버십이나 권한이 바뀐 뒤 키 상태 캐시를 비울 대상이다.
 *
 * @param {string} groupId
 * @returns {Promise<string[]>}
 */
export async function groupMemberKeyIds(groupId) {
  const { rows } = await getPrimaryPool().query(
    `SELECT key_id FROM ${SCHEMA}.api_key_group_members WHERE group_id = $1 ORDER BY key_id`, [groupId]
  );
  return rows.map((r) => r.key_id);
}

/**
 * 멤버를 그룹에 넣는다. permissions를 주지 않으면 기본 권한, sharedWorkspaces를 주지 않으면 전체 공유이고, 이미
 * 멤버면 바꾸지 않는다. 권한과 공유 범위를 함께 정하지 않은 설치(migration-073 전)에서는 기본값만 넣는다.
 *
 * @param {string} keyId
 * @param {string} groupId
 * @param {string[]|undefined} permissions
 * @param {string[]|null|undefined} [sharedWorkspaces]
 * @returns {Promise<{ keyId: string, groupId: string, added: boolean, permissions: string[], sharedWorkspaces: string[]|null }>}
 */
export async function addGroupMember(keyId, groupId, permissions = undefined, sharedWorkspaces = undefined) {
  const perms  = permissions === undefined ? [...DEFAULT_MEMBER_PERMISSIONS] : normalizeMemberPermissions(permissions);
  const shared = sharedWorkspaces === undefined ? null : normalizeSharedWorkspaces(sharedWorkspaces);
  const pool   = getPrimaryPool();
  if (permissions === undefined && sharedWorkspaces === undefined) {
    const { rowCount } = await pool.query(
      `INSERT INTO ${SCHEMA}.api_key_group_members (group_id, key_id) VALUES ($1, $2) ON CONFLICT (group_id, key_id) DO NOTHING`,
      [groupId, keyId]
    );
    return { keyId, groupId, added: rowCount > 0, permissions: perms, sharedWorkspaces: null };
  }
  const { rowCount } = await pool.query(
    `INSERT INTO ${SCHEMA}.api_key_group_members (group_id, key_id, permissions, shared_workspaces) VALUES ($1, $2, $3::text[], $4::text[])
     ON CONFLICT (group_id, key_id) DO NOTHING`,
    [groupId, keyId, perms, shared]
  );
  return { keyId, groupId, added: rowCount > 0, permissions: perms, sharedWorkspaces: shared };
}

/**
 * 멤버 권한이나 공유 workspace를 바꾼다. 준 값만 바꾸고, 둘 다 없으면 입력 오류다. 멤버가 아니면 null이다.
 *
 * @param {string} groupId
 * @param {string} keyId
 * @param {{ permissions?: unknown, sharedWorkspaces?: unknown }} change sharedWorkspaces null은 전체 공유
 * @returns {Promise<{ keyId: string, groupId: string, permissions: string[], previous: string[],
 *                     sharedWorkspaces: string[]|null, previousSharedWorkspaces: string[]|null }|null>}
 */
export async function setGroupMemberPermissions(groupId, keyId, change) {
  const hasPerms  = change.permissions !== undefined;
  const hasShared = change.sharedWorkspaces !== undefined;
  if (!hasPerms && !hasShared) throw new GroupPermissionError("permissions or shared_workspaces is required");
  const perms  = hasPerms ? normalizeMemberPermissions(change.permissions) : null;
  const shared = hasShared ? normalizeSharedWorkspaces(change.sharedWorkspaces) : null;
  const { rows } = await getPrimaryPool().query(
    `WITH prev AS (
       SELECT permissions, shared_workspaces FROM ${SCHEMA}.api_key_group_members WHERE group_id = $1 AND key_id = $2 FOR UPDATE
     )
     UPDATE ${SCHEMA}.api_key_group_members m
        SET permissions       = CASE WHEN $4 THEN $3::text[] ELSE m.permissions END,
            shared_workspaces = CASE WHEN $6 THEN $5::text[] ELSE m.shared_workspaces END,
            updated_at        = NOW()
       FROM prev
      WHERE m.group_id = $1 AND m.key_id = $2
     RETURNING prev.permissions AS previous, m.permissions,
               prev.shared_workspaces AS previous_shared, m.shared_workspaces`,
    [groupId, keyId, perms, hasPerms, shared, hasShared]
  );
  // iron-laws: ignore[IL-307] null은 없는 멤버이고 호출부가 404로 응답한다
  if (rows.length === 0) return null;
  return {
    keyId, groupId,
    permissions             : rows[0].permissions,
    previous                : rows[0].previous,
    sharedWorkspaces        : rows[0].shared_workspaces ?? null,
    previousSharedWorkspaces: rows[0].previous_shared ?? null
  };
}

/**
 * 그룹 멤버끼리의 실효 권한. 멤버마다 getGroupAccess(다른 그룹에서 받은 권한까지 합친 판정)를 구해, 같은 그룹의
 * 다른 멤버 쌍마다 읽기, 링크, 수정, 삭제 가능 여부와 공유 workspace 제한(null은 전체)을 싣는다. 판정 함수를 그대로
 * 쓰므로 실제 요청이 받는 권한과 같다.
 *
 * @param {string} groupId
 * @returns {Promise<Array<{ from: string, to: string, read: boolean, link: boolean, amend: boolean, forget: boolean,
 *                           sharedWorkspaces: string[]|null }>>}
 */
export async function groupEffectiveAccess(groupId) {
  const members = await groupMemberKeyIds(groupId);
  const rows    = [];
  for (const from of members) {
    const access = await getGroupAccess(from);
    for (const to of members) {
      if (to === from) continue;
      const read = access.groupKeyIds.includes(to);
      rows.push({
        from, to, read,
        link            : access.groupGrants.link.includes(to),
        amend           : access.groupGrants.amend.includes(to),
        forget          : access.groupGrants.forget.includes(to),
        sharedWorkspaces: read ? (access.groupShareScopes?.[to] ?? null) : []
      });
    }
  }
  return rows;
}

/**
 * 이 키의 파편을 읽은 다른 키(마스터 포함)를 검색 기록으로 센다. search_events에는 요청 키와 응답에 담긴 파편
 * id(selected_fragment_ids)가 남으므로, 그 파편의 소유 키가 이 키이고 요청 키가 다른 기록만 모은다. 쓰기 경로에
 * 따로 기록하지 않는다.
 *
 * @param {string} keyId
 * @param {number} days 1~90
 * @returns {Promise<Array<{ reader_key_id: string|null, reader_name: string|null, searches: number, fragments: number, last_at: string }>>}
 */
export async function sharedReadsOf(keyId, days) {
  const { rows } = await getPrimaryPool().query(
    `SELECT e.key_id AS reader_key_id, k.name AS reader_name,
            count(DISTINCT e.id)::int AS searches, count(DISTINCT f.id)::int AS fragments, max(e.created_at) AS last_at
       FROM ${SCHEMA}.search_events e
       CROSS JOIN LATERAL unnest(e.selected_fragment_ids) AS sid(id)
       JOIN ${SCHEMA}.fragments f ON f.id = sid.id
       LEFT JOIN ${SCHEMA}.api_keys k ON k.id = e.key_id
      WHERE e.created_at > NOW() - make_interval(days => $2)
        AND f.key_id = $1
        AND e.key_id IS DISTINCT FROM $1
      GROUP BY e.key_id, k.name
      ORDER BY searches DESC`,
    [keyId, days]
  );
  return rows;
}
