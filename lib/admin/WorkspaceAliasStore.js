/**
 * Admin: 키별 workspace 별칭과 workspace 병합(key_workspace_aliases, migration-079)
 *
 * 작성자: 최진호
 * 작성일: 2026-11-04
 *
 * 별칭은 요청에 들어온 workspace 이름을 정식 이름으로 바꾼다(lib/keys/workspace-alias.js). 병합은 이미 별칭 이름으로
 * 저장된 파편을 정식 이름으로 옮긴다. 정식 이름 쪽에 같은 본문(content_hash)이 이미 있으면 옮길 수 없으므로(중복 판정
 * 색인) 그 행은 원래 이름에 둔 채 닫는다(valid_to). 별칭 제안은 경로형 workspace 가운데 마지막 조각과 같은 일반
 * workspace가 같은 키에 이미 있는 것만 고른다. 마지막 조각만 같은 서로 다른 경로를 자동으로 합치지 않는다.
 */

import { getPrimaryPool } from "../tools/db.js";
import { logWarn }        from "../logger.js";
import { SCHEMA, DEINDEX_COLUMNS } from "../memory/schema.js";
import { beginScoped, queryScoped, ROW_SUBJECT } from "../tools/row-scope.js";

/** 경로형 workspace(POSIX 절대 경로, 홈 경로, Windows 드라이브나 UNC 경로) */
const PATH_LIKE = /^(?:\/|~\/|[A-Za-z]:[\\/]|\\\\)/;

/** 입력 오류 */
export class WorkspaceAliasError extends Error {
  constructor(message) {
    super(message);
    this.name = "WorkspaceAliasError";
  }
}

/**
 * 경로의 마지막 조각. 경로형이 아니거나 조각이 없으면 null이다.
 *
 * @param {string} workspace
 * @returns {string|null}
 */
export function pathTail(workspace) {
  if (typeof workspace !== "string" || !PATH_LIKE.test(workspace)) return null;
  return workspace.split(/[\\/]/).filter(Boolean).at(-1) ?? null;
}

/**
 * 별칭 입력을 검사한다. workspace가 null이면 별칭을 지운다.
 *
 * @param {unknown} alias
 * @param {unknown} workspace
 * @returns {{ alias: string, workspace: string|null }}
 */
export function normalizeAliasInput(alias, workspace) {
  if (typeof alias !== "string" || alias.trim() === "" || alias.length > 4096) {
    throw new WorkspaceAliasError("alias must be a 1-4096 character workspace name");
  }
  if (workspace !== null && (typeof workspace !== "string" || workspace.trim() === "" || workspace.length > 128)) {
    throw new WorkspaceAliasError("workspace must be null (remove) or a 1-128 character name");
  }
  const a = alias.trim();
  const w = workspace === null ? null : workspace.trim();
  if (a === w) throw new WorkspaceAliasError("alias and workspace must differ");
  return { alias: a, workspace: w };
}

/**
 * @param {string} keyId
 * @returns {Promise<Array<{ alias: string, workspace: string, created_at: string }>>}
 */
export async function listWorkspaceAliases(keyId) {
  const { rows } = await getPrimaryPool().query(
    `SELECT alias, workspace, created_at FROM ${SCHEMA}.key_workspace_aliases WHERE key_id = $1 ORDER BY workspace, alias`,
    [keyId]
  );
  return rows;
}

/**
 * 별칭을 넣거나 바꾸거나(workspace) 지운다(null). 사슬(정식 이름이 다른 별칭이거나, 별칭이 다른 별칭의 정식 이름)은
 * 거부한다.
 *
 * @param {string} keyId
 * @param {{ alias: string, workspace: string|null }} input normalizeAliasInput 결과
 * @returns {Promise<{ alias: string, previous: string|null, workspace: string|null }>}
 */
export async function setWorkspaceAlias(keyId, { alias, workspace }) {
  const pool = getPrimaryPool();
  const { rows } = await pool.query(
    `SELECT alias, workspace FROM ${SCHEMA}.key_workspace_aliases WHERE key_id = $1 AND (alias = ANY($2::text[]) OR workspace = $3)`,
    [keyId, workspace === null ? [alias] : [alias, workspace], alias]
  );
  const previous = rows.find((r) => r.alias === alias)?.workspace ?? null;
  if (workspace === null) {
    await pool.query(`DELETE FROM ${SCHEMA}.key_workspace_aliases WHERE key_id = $1 AND alias = $2`, [keyId, alias]);
    return { alias, previous, workspace: null };
  }
  if (rows.some((r) => r.alias === workspace)) throw new WorkspaceAliasError(`"${workspace}" is itself an alias; point to its workspace instead`);
  if (rows.some((r) => r.workspace === alias)) throw new WorkspaceAliasError(`"${alias}" is the workspace of other aliases; it cannot become an alias`);
  await pool.query(
    `INSERT INTO ${SCHEMA}.key_workspace_aliases (key_id, alias, workspace) VALUES ($1, $2, $3)
     ON CONFLICT (key_id, alias) DO UPDATE SET workspace = EXCLUDED.workspace`,
    [keyId, alias, workspace]
  );
  return { alias, previous, workspace };
}

/**
 * 별칭 후보. 키마다 경로형 workspace의 마지막 조각과 같은 일반 workspace가 이미 있으면 후보다.
 *
 * @param {string|null} [keyId] 없으면 모든 키
 * @returns {Promise<Array<{ keyId: string, alias: string, workspace: string, aliasFragments: number, workspaceFragments: number }>>}
 */
export async function suggestWorkspaceAliases(keyId = null) {
  const params    = keyId == null ? [] : [keyId];
  const keyFilter = keyId == null ? "" : "AND key_id = $1";
  const { rows } = await queryScoped(getPrimaryPool(),
    `SELECT key_id, workspace, count(*)::int AS n
       FROM ${SCHEMA}.fragments
      WHERE key_id IS NOT NULL AND workspace IS NOT NULL AND valid_to IS NULL
        ${keyFilter}
      GROUP BY key_id, workspace`,
    params, ROW_SUBJECT.ADMIN
  );
  const byKey = new Map();
  for (const r of rows) {
    if (!byKey.has(r.key_id)) byKey.set(r.key_id, new Map());
    byKey.get(r.key_id).set(r.workspace, r.n);
  }
  const out = [];
  for (const [k, names] of byKey) {
    for (const [name, n] of names) {
      const tail = pathTail(name);
      if (tail && !PATH_LIKE.test(tail) && names.has(tail)) {
        out.push({ keyId: k, alias: name, workspace: tail, aliasFragments: n, workspaceFragments: names.get(tail) });
      }
    }
  }
  return out.sort((a, b) => b.aliasFragments - a.aliasFragments);
}

/**
 * 키 하나의 workspace from 파편(닫힌 행 포함)을 to로 옮긴다. apply가 아니면 수만 센다. to에 같은 본문이 이미 있는
 * 행은 옮기지 않고 from에 둔 채 닫는다.
 *
 * @param {string} keyId
 * @param {string} from
 * @param {string} to
 * @param {{ apply?: boolean }} [opts]
 * closedRows는 닫은 행의 색인 정리 열(DEINDEX_COLUMNS)이다. 호출자가 deindexRows로 Redis 색인에서 뺀다.
 *
 * @returns {Promise<{ moved: number, closedDuplicates: number, applied: boolean, ids: string[], closedRows: object[] }>}
 */
export async function mergeWorkspace(keyId, from, to, { apply = false } = {}) {
  if (!from || !to || from === to) throw new WorkspaceAliasError("from and to must be different workspace names");
  const pool   = getPrimaryPool();
  const client = await pool.connect();
  try {
    await beginScoped(pool, client, { subject: ROW_SUBJECT.ADMIN });
    const { rows } = await client.query(
      `SELECT f.id, f.valid_to IS NULL AS live,
              EXISTS (SELECT 1 FROM ${SCHEMA}.fragments t
                       WHERE t.key_id = f.key_id AND t.content_hash = f.content_hash AND t.workspace = $3) AS duplicate
         FROM ${SCHEMA}.fragments f
        WHERE f.key_id = $1 AND f.workspace = $2
        ORDER BY f.id
        ${apply ? "FOR UPDATE OF f" : ""}`,
      [keyId, from, to]
    );
    const moveIds  = rows.filter((r) => !r.duplicate).map((r) => r.id);
    const closeIds = rows.filter((r) => r.duplicate && r.live).map((r) => r.id);
    if (!apply) {
      await client.query("ROLLBACK");
      return { moved: moveIds.length, closedDuplicates: closeIds.length, applied: false, ids: [], closedRows: [] };
    }
    const closedRows = closeIds.length === 0 ? [] : (await client.query(
      `UPDATE ${SCHEMA}.fragments SET valid_to = NOW() WHERE id = ANY($1::text[]) RETURNING ${DEINDEX_COLUMNS}`, [closeIds]
    )).rows;
    if (moveIds.length > 0) {
      await client.query(`UPDATE ${SCHEMA}.fragments SET workspace = $2 WHERE id = ANY($1::text[])`, [moveIds, to]);
    }
    await client.query("COMMIT");
    return { moved: moveIds.length, closedDuplicates: closeIds.length, applied: true, ids: [...moveIds, ...closeIds], closedRows };
  } catch (err) {
    await client.query("ROLLBACK").catch((rollbackErr) => logWarn(`[WorkspaceAlias] merge rollback failed: ${rollbackErr.message}`));
    throw err;
  } finally {
    client.release();
  }
}
