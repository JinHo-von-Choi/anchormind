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
