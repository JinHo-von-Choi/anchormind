/**
 * FragmentExporter - 파편 내보내기 줄 생성기
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 호출자가 정한 WHERE 조건으로 파편을 id 순 묶음으로 읽어 JSON Lines 줄을 만든다. 버전 2는
 * 머리 줄, 파편 줄, 링크 줄, (선택) 이력 줄, 끝 줄이고, 버전 1은 파편 줄만이다. 링크와 이력은
 * 내보낸 파편 사이의 것만 싣는다. admin 내보내기와 CLI 내보내기가 함께 쓰며, 질의는 호출자가
 * 넘긴 query 함수로 실행한다.
 */

import { SCHEMA } from "../schema.js";
import {
  RECORD, V1_FRAGMENT_COLUMNS, V2_FRAGMENT_COLUMNS, LINK_COLUMNS, VERSION_COLUMNS,
  buildHeader, buildTrailer, migrationNumber
} from "./exportFormat.js";

/** 한 번에 읽는 파편 수. */
export const EXPORT_BATCH_SIZE = 500;

/** 링크와 이력 조회에 한 번에 넘기는 파편 id 수. */
const RELATED_CHUNK = 1000;

/** schema_migrations 표가 없을 때의 SQLSTATE(undefined_table). */
const UNDEFINED_TABLE = "42P01";

/**
 * 마지막으로 적용된 마이그레이션 번호를 읽는다. 표가 없으면 null이다.
 *
 * @param {(sql: string, params?: Array) => Promise<{rows: Array}>} query
 * @returns {Promise<string|null>}
 */
export async function readSchemaMigration(query) {
  try {
    const { rows } = await query(
      `SELECT filename FROM ${SCHEMA}.schema_migrations ORDER BY filename DESC LIMIT 1`
    );
    return migrationNumber(rows[0]?.filename);
  } catch (err) {
    if (err?.code === UNDEFINED_TABLE) return null;
    throw err;
  }
}

/** 열 이름 목록을 SELECT 절로 만든다. */
function selectList(columns) {
  return columns.join(", ");
}

/**
 * 파편 묶음 하나를 읽는다.
 *
 * @param {Function} query
 * @param {Object}   input
 * @param {string}   input.where   - "valid_to IS NULL ..." 로 시작하는 조건식
 * @param {Array}    input.params  - where의 바인딩
 * @param {string[]} input.columns
 * @param {string|null} input.afterId - 이 id보다 큰 행부터 읽는다
 * @param {number}   input.limit
 * @returns {Promise<Array<Object>>}
 */
async function readFragmentBatch(query, { where, params, columns, afterId, limit }) {
  const bound = [...params];
  let   sql   = `SELECT ${selectList(columns)} FROM ${SCHEMA}.fragments WHERE ${where}`;
  if (afterId !== null) {
    bound.push(afterId);
    sql += ` AND id > $${bound.length}`;
  }
  bound.push(limit);
  sql += ` ORDER BY id LIMIT $${bound.length}`;
  const { rows } = await query(sql, bound);
  return rows;
}

/**
 * 조건에 맞는 파편 행을 id 순으로 내보낸다. limit이 있으면 그 수에서 멈춘다.
 *
 * @param {Function} query
 * @param {Object}   input - readFragmentBatch 입력에서 afterId와 limit을 뺀 값과 max
 * @param {number|null} input.max
 * @returns {AsyncGenerator<Object[]>} 묶음 단위
 */
async function* fragmentBatches(query, { where, params, columns, max }) {
  let afterId  = null;
  let produced = 0;
  while (max === null || produced < max) {
    const limit = max === null ? EXPORT_BATCH_SIZE : Math.min(EXPORT_BATCH_SIZE, max - produced);
    const rows  = await readFragmentBatch(query, { where, params, columns, afterId, limit });
    if (rows.length === 0) return;
    yield rows;
    produced += rows.length;
    afterId   = rows[rows.length - 1].id;
    if (rows.length < limit) return;
  }
}

/**
 * NUMERIC 열(confidence, decay_rate)은 드라이버가 문자열로 돌려주므로 JSON 숫자로 바꾼다.
 *
 * @param {Object} link
 * @returns {Object}
 */
function withNumericLinkColumns(link) {
  return { ...link, confidence: Number(link.confidence), decay_rate: Number(link.decay_rate) };
}

/**
 * 내보낸 파편 id 묶음에서 나가는 링크 중 양 끝이 모두 내보낸 파편인 것만 읽는다.
 *
 * @param {Function} query
 * @param {string[]} ids
 * @param {Set<string>} exported
 * @returns {Promise<Array<Object>>}
 */
async function readLinks(query, ids, exported) {
  const { rows } = await query(
    `SELECT ${selectList(LINK_COLUMNS)} FROM ${SCHEMA}.fragment_links
      WHERE from_id = ANY($1::text[]) AND deleted_at IS NULL
      ORDER BY from_id, to_id`,
    [ids]
  );
  return rows.filter(r => exported.has(r.to_id)).map(withNumericLinkColumns);
}

/**
 * 내보낸 파편 id 묶음의 이력 행을 읽는다.
 *
 * @param {Function} query
 * @param {string[]} ids
 * @returns {Promise<Array<Object>>}
 */
async function readVersions(query, ids) {
  const { rows } = await query(
    `SELECT ${selectList(VERSION_COLUMNS)} FROM ${SCHEMA}.fragment_versions
      WHERE fragment_id = ANY($1::text[])
      ORDER BY fragment_id, id`,
    [ids]
  );
  return rows;
}

/**
 * 내보낸 파편 id 전체에 대해 링크 기록을 만든다.
 *
 * @param {Function} query
 * @param {string[]} ids
 * @param {Set<string>} exported
 * @returns {AsyncGenerator<Object>}
 */
async function* linkRecords(query, ids, exported) {
  for (let i = 0; i < ids.length; i += RELATED_CHUNK) {
    for (const link of await readLinks(query, ids.slice(i, i + RELATED_CHUNK), exported)) {
      yield { record: RECORD.LINK, ...link };
    }
  }
}

/**
 * 내보낸 파편 id 전체에 대해 이력 기록을 만든다.
 *
 * @param {Function} query
 * @param {string[]} ids
 * @returns {AsyncGenerator<Object>}
 */
async function* versionRecords(query, ids) {
  for (let i = 0; i < ids.length; i += RELATED_CHUNK) {
    for (const row of await readVersions(query, ids.slice(i, i + RELATED_CHUNK))) {
      yield { record: RECORD.VERSION, ...row };
    }
  }
}

/**
 * 내보내기 기록(JavaScript 객체)을 순서대로 만든다. 직렬화는 호출자가 한다.
 *
 * @param {Object}   options
 * @param {(sql: string, params?: Array) => Promise<{rows: Array}>} options.query
 * @param {string}   options.where        - 파편 조건식(valid_to IS NULL로 시작)
 * @param {Array}    options.params       - where의 바인딩
 * @param {number}   [options.version=2]  - 형식 버전
 * @param {boolean}  [options.includeLinks=true]
 * @param {boolean}  [options.includeVersions=false]
 * @param {number|null} [options.max=null] - 내보낼 파편 수 상한
 * @param {Object}   [options.scope={}]   - 머리 줄에 적는 내보내기 조건
 * @returns {AsyncGenerator<Object>}
 */
export async function* exportRecords({
  query, where, params, version = 2, includeLinks = true, includeVersions = false, max = null, scope = {}
}) {
  if (version === 1) {
    for await (const rows of fragmentBatches(query, { where, params, columns: V1_FRAGMENT_COLUMNS, max })) yield* rows;
    return;
  }

  const includes = [RECORD.FRAGMENT, ...(includeLinks ? [RECORD.LINK] : []), ...(includeVersions ? [RECORD.VERSION] : [])];
  yield buildHeader({ schemaMigration: await readSchemaMigration(query), scope, includes });

  const counts   = { fragments: 0, links: 0, versions: 0 };
  const exported = new Set();
  for await (const rows of fragmentBatches(query, { where, params, columns: V2_FRAGMENT_COLUMNS, max })) {
    for (const row of rows) {
      counts.fragments++;
      exported.add(row.id);
      yield { record: RECORD.FRAGMENT, ...row };
    }
  }

  const ids = [...exported];
  if (includeLinks) {
    for await (const record of linkRecords(query, ids, exported)) {
      counts.links++;
      yield record;
    }
  }
  if (includeVersions) {
    for await (const record of versionRecords(query, ids)) {
      counts.versions++;
      yield record;
    }
  }
  yield buildTrailer(counts);
}
