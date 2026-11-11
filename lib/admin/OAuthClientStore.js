/**
 * OAuth 클라이언트 저장소 (RFC 7591 Dynamic Client Registration)
 *
 * 작성자: 최진호
 * 작성일: 2026-04-02
 */

import { randomBytes } from "node:crypto";
import { getPrimaryPool } from "../tools/db.js";
import { logError }       from "../logger.js";
import { SCHEMA } from "../memory/schema.js";

/**
 * 클라이언트 등록 (RFC 7591)
 */
export async function registerClient(opts) {
  const pool       = getPrimaryPool();
  const clientId   = opts.client_id || ("mmcp_" + randomBytes(16).toString("hex"));
  const redirectUris = Array.isArray(opts.redirect_uris) ? opts.redirect_uris : [];

  if (!redirectUris.length) throw new Error("redirect_uris is required");

  const { rows } = await pool.query(`
    INSERT INTO ${SCHEMA}.oauth_clients
      (client_id, client_name, redirect_uris, scope, client_uri, logo_uri)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (client_id) DO UPDATE SET last_used_at = NOW()
    RETURNING client_id, client_name, redirect_uris, grant_types, response_types, scope, created_at
  `, [
    clientId,
    opts.client_name || null,
    redirectUris,
    opts.scope || "mcp",
    opts.client_uri || null,
    opts.logo_uri || null
  ]);
  return rows[0];
}

/**
 * client_id로 클라이언트 조회
 */
export async function getClient(clientId) {
  if (!clientId) return null;
  const pool     = getPrimaryPool();
  const { rows } = await pool.query(
    `SELECT * FROM ${SCHEMA}.oauth_clients WHERE client_id = $1`,
    [clientId]
  );
  if (!rows.length) return null;

  pool.query(
    `UPDATE ${SCHEMA}.oauth_clients SET last_used_at = NOW() WHERE client_id = $1`,
    [clientId]
  ).catch(err => logError("[OAuth] client last_used_at update:", err));

  return rows[0];
}

/**
 * redirect_uri가 클라이언트 등록 시 제공한 것과 일치하는지 검증
 */
export function validateRedirectUri(client, redirectUri) {
  return (client.redirect_uris || []).includes(redirectUri);
}

/**
 * 전체 클라이언트 목록 (admin용)
 */
export async function listClients() {
  const pool     = getPrimaryPool();
  const { rows } = await pool.query(`
    SELECT client_id, client_name, redirect_uris, scope, created_at, last_used_at
    FROM ${SCHEMA}.oauth_clients
    ORDER BY created_at DESC
  `);
  return rows;
}

/**
 * 클라이언트 삭제
 */
export async function deleteClient(clientId) {
  const pool         = getPrimaryPool();
  const { rowCount } = await pool.query(
    `DELETE FROM ${SCHEMA}.oauth_clients WHERE client_id = $1`,
    [clientId]
  );
  if (!rowCount) throw new Error("Client not found");
}

/** 발급 API 키 원문 형식. 이 형식의 client_id는 목록 출력에서 가린다. */
const RAW_API_KEY_FORMAT = /^mmcp_[a-z0-9]{1,8}_[0-9a-f]{32}$/;

/**
 * 한 번도 쓰이지 않은 오래된 DCR 클라이언트를 정리한다.
 * 대상: last_used_at IS NULL, created_at이 olderThanDays일보다 오래됨, 키에 묶인 클라이언트(apikey:) 제외.
 * execute=false(기본)는 후보 수와 표본만 돌려준다. execute=true는 batchSize씩 나눠 지운다.
 *
 * @param {{ query: Function }} pool
 * @param {{ olderThanDays?: number, execute?: boolean, batchSize?: number, sampleSize?: number }} [opts]
 * @returns {Promise<{ execute: boolean, candidates: number, deleted: number, sample: Array<object> }>}
 */
export async function purgeUnusedClients(pool, { olderThanDays = 30, execute = false, batchSize = 200, sampleSize = 20 } = {}) {
  if (!Number.isInteger(olderThanDays) || olderThanDays < 1) throw new Error("olderThanDays must be a positive integer");
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 5000) throw new Error("batchSize must be 1..5000");

  const where = `last_used_at IS NULL
       AND created_at < NOW() - make_interval(days => $1)
       AND (client_name IS NULL OR client_name !~* '^apikey:')`;

  const { rows: [count] } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM ${SCHEMA}.oauth_clients WHERE ${where}`,
    [olderThanDays]
  );
  const { rows: sampleRows } = await pool.query(
    `SELECT client_id, created_at, redirect_uris[1] AS first_redirect
       FROM ${SCHEMA}.oauth_clients WHERE ${where}
      ORDER BY created_at LIMIT $2`,
    [olderThanDays, sampleSize]
  );
  const sample = sampleRows.map((r) => ({
    client_id     : RAW_API_KEY_FORMAT.test(r.client_id) ? "mmcp_****" : r.client_id,
    created_at    : r.created_at,
    redirect_host : URL.canParse(r.first_redirect ?? "") ? new URL(r.first_redirect).host : null
  }));

  if (!execute) return { execute: false, candidates: count.n, deleted: 0, sample };

  let deleted = 0;
  for (;;) {
    const { rowCount } = await pool.query(
      `DELETE FROM ${SCHEMA}.oauth_clients
        WHERE client_id IN (
          SELECT client_id FROM ${SCHEMA}.oauth_clients WHERE ${where}
           ORDER BY created_at LIMIT $2
        )`,
      [olderThanDays, batchSize]
    );
    deleted += rowCount;
    if (rowCount < batchSize) break;
  }
  return { execute: true, candidates: count.n, deleted, sample };
}
