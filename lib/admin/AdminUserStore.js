/**
 * 관리자 계정, 역할 바인딩, DB 세션, TOTP, 복구 코드 저장소
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 생성자가 받은 pg 풀만 쓴다(서버는 주 풀, 복구 CLI는 명시한 접속 대상의 풀). 설정 모듈과 DB 모듈을 가져오지 않는다.
 *
 * 계정 변경(부트스트랩, 생성, 상태 변경, 역할 변경, 삭제)은 트랜잭션 안에서 먼저 계정 표 advisory 잠금
 * (pg_advisory_xact_lock)을 잡는다. 잠금 뒤의 문장은 새 스냅숏으로 읽으므로 두 변경이 서로의 결과를 보지 못하는
 * 경쟁이 없다. 마지막 owner 보호는 그 잠금 아래에서 활성 owner 행을 FOR UPDATE로 잠그고 판정한다
 * (admin-session-policy.ownerChangeDecision). 부트스트랩은 같은 잠금 아래에서 계정이 0개일 때만 첫 owner를 만든다.
 *
 * 세션은 토큰 해시로 찾는다. 회전은 옛 세션을 rotated로 폐기하고 같은 계열의 새 행을 넣는 한 트랜잭션이며, 옛 세션이
 * 이미 폐기됐으면 아무것도 넣지 않는다. 폐기된 rotated 토큰이 다시 오면 호출자가 계열 전체를 폐기한다.
 * TOTP 단계 기록은 저장된 단계보다 클 때만 갱신하는 한 문장이라 같은 코드를 두 요청이 동시에 써도 하나만 통과한다.
 * 복구 코드 사용도 used_at IS NULL 조건의 한 문장이다.
 */

import crypto from "node:crypto";

import { SCHEMA } from "../memory/schema.js";
import { hasGlobalOwner, ownerChangeDecision, roleChangeRemovesOwner } from "./admin-session-policy.js";

const USERS    = `${SCHEMA}.admin_users`;
const BINDINGS = `${SCHEMA}.admin_role_bindings`;
const SESSIONS = `${SCHEMA}.admin_sessions`;
const CODES    = `${SCHEMA}.admin_recovery_codes`;

const LOCK_SQL = `SELECT pg_advisory_xact_lock(hashtextextended('${USERS}', 0))`;

const BINDINGS_JSON = `COALESCE((SELECT json_agg(json_build_object('role', b.role, 'workspace', b.workspace) ORDER BY b.id)
                          FROM ${BINDINGS} b WHERE b.user_id = u.id), '[]'::json) AS bindings`;

const PUBLIC_COLUMNS = `u.id, u.username, u.status, u.totp_enabled_at, u.created_at, u.updated_at, u.last_login_at, u.created_by`;

const ACTIVE_OWNERS_SQL = `SELECT u.id FROM ${USERS} u
  WHERE u.status = 'active'
    AND EXISTS (SELECT 1 FROM ${BINDINGS} b WHERE b.user_id = u.id AND b.role = 'owner' AND b.workspace IS NULL)
  ORDER BY u.id
  FOR UPDATE OF u`;

/** 계정 변경 거절(상태 충돌, 없는 계정). code는 응답 사유, status는 HTTP 상태다. */
export class AdminUserStoreError extends Error {
  /**
   * @param {string} code
   * @param {number} status
   */
  constructor(code, status) {
    super(code);
    this.name   = "AdminUserStoreError";
    this.code   = code;
    this.status = status;
  }
}

/**
 * 공개 계정 값. 비밀번호 해시와 TOTP 봉인 값은 싣지 않는다.
 *
 * @param {object} row
 * @returns {object}
 */
export function publicUser(row) {
  return {
    id         : row.id,
    username   : row.username,
    status     : row.status,
    roles      : Array.isArray(row.bindings) ? row.bindings : [],
    totpEnabled: Boolean(row.totp_enabled_at),
    createdAt  : row.created_at ?? null,
    updatedAt  : row.updated_at ?? null,
    lastLoginAt: row.last_login_at ?? null,
    createdBy  : row.created_by ?? null
  };
}

export class AdminUserStore {
  /**
   * @param {import("pg").Pool} pool
   */
  constructor(pool) {
    this.pool = pool;
  }

  /**
   * 트랜잭션 안에서 fn을 실행한다.
   *
   * @template T
   * @param {(client: import("pg").PoolClient) => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async transaction(fn) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch((rollbackErr) => {
        err.rollbackError = rollbackErr;
      });
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * 계정 수.
   *
   * @returns {Promise<number>}
   */
  async countUsers() {
    const { rows } = await this.pool.query(`SELECT COUNT(*)::int AS n FROM ${USERS}`);
    return rows[0].n;
  }

  /**
   * 계정 목록(공개 값).
   *
   * @returns {Promise<object[]>}
   */
  async listUsers() {
    const { rows } = await this.pool.query(`SELECT ${PUBLIC_COLUMNS}, ${BINDINGS_JSON} FROM ${USERS} u ORDER BY u.created_at, u.id`);
    return rows.map(publicUser);
  }

  /**
   * 계정 하나(공개 값). 없으면 null.
   *
   * @param {string} id
   * @param {import("pg").PoolClient|import("pg").Pool} [db]
   * @returns {Promise<object|null>}
   */
  async getUser(id, db = this.pool) {
    const { rows } = await db.query(`SELECT ${PUBLIC_COLUMNS}, ${BINDINGS_JSON} FROM ${USERS} u WHERE u.id = $1`, [id]);
    return rows[0] ? publicUser(rows[0]) : null;
  }

  /**
   * 로그인 판정용 계정 행(비밀번호 해시, TOTP 상태, 바인딩). 없으면 null.
   *
   * @param {string} norm 중복 판정 값(소문자)
   * @returns {Promise<object|null>}
   */
  async findLoginUser(norm) {
    const { rows } = await this.pool.query(
      `SELECT u.id, u.username, u.password_hash, u.status, u.totp_secret_sealed, u.totp_enabled_at, u.totp_last_step,
              ${BINDINGS_JSON}
         FROM ${USERS} u WHERE u.username_norm = $1`, [norm]);
    return rows[0] ?? null;
  }

  /**
   * 계정 행과 바인딩을 넣는다(잠금을 잡은 트랜잭션 안).
   */
  async #insertUser(client, { username, norm, passwordHash, bindings, createdBy }) {
    const id = crypto.randomUUID();
    const taken = await client.query(`SELECT 1 FROM ${USERS} WHERE username_norm = $1`, [norm]);
    if (taken.rowCount > 0) throw new AdminUserStoreError("username_taken", 409);
    await client.query(
      `INSERT INTO ${USERS} (id, username, username_norm, password_hash, created_by) VALUES ($1, $2, $3, $4, $5)`,
      [id, username, norm, passwordHash, createdBy ?? null]);
    await this.#insertBindings(client, id, bindings, createdBy);
    return id;
  }

  async #insertBindings(client, userId, bindings, createdBy) {
    for (const b of bindings) {
      await client.query(`INSERT INTO ${BINDINGS} (user_id, role, workspace, created_by) VALUES ($1, $2, $3, $4)`,
        [userId, b.role, b.workspace, createdBy ?? null]);
    }
  }

  /**
   * 첫 owner를 만든다. 계정이 하나라도 있으면 already_bootstrapped.
   *
   * @param {{ username: string, norm: string, passwordHash: string, createdBy: string }} args
   * @returns {Promise<object>}
   */
  async bootstrapOwner({ username, norm, passwordHash, createdBy }) {
    return this.transaction(async (client) => {
      await client.query(LOCK_SQL);
      const { rows } = await client.query(`SELECT COUNT(*)::int AS n FROM ${USERS}`);
      if (rows[0].n > 0) throw new AdminUserStoreError("already_bootstrapped", 409);
      const id = await this.#insertUser(client, { username, norm, passwordHash, bindings: [{ role: "owner", workspace: null }], createdBy });
      return this.getUser(id, client);
    });
  }

  /**
   * 계정을 만든다. 계정이 0개면 bootstrap_required(첫 계정은 부트스트랩으로만 만든다).
   *
   * @param {{ username: string, norm: string, passwordHash: string, bindings: object[], createdBy: string }} args
   * @returns {Promise<object>}
   */
  async createUser({ username, norm, passwordHash, bindings, createdBy }) {
    return this.transaction(async (client) => {
      await client.query(LOCK_SQL);
      const { rows } = await client.query(`SELECT COUNT(*)::int AS n FROM ${USERS}`);
      if (rows[0].n === 0) throw new AdminUserStoreError("bootstrap_required", 409);
      const id = await this.#insertUser(client, { username, norm, passwordHash, bindings, createdBy });
      return this.getUser(id, client);
    });
  }

  /**
   * 잠금 아래에서 대상 계정과 활성 owner 목록을 읽는다.
   */
  async #lockForChange(client, id) {
    await client.query(LOCK_SQL);
    const owners = (await client.query(ACTIVE_OWNERS_SQL)).rows.map((r) => r.id);
    const { rows } = await client.query(`SELECT ${PUBLIC_COLUMNS}, ${BINDINGS_JSON} FROM ${USERS} u WHERE u.id = $1 FOR UPDATE OF u`, [id]);
    if (!rows[0]) throw new AdminUserStoreError("not_found", 404);
    return { owners, user: rows[0] };
  }

  /**
   * 마지막 owner 보호.
   */
  static #guardOwner(owners, id, removesOwner) {
    const decision = ownerChangeDecision({ activeOwnerIds: owners, targetId: id, removesOwner });
    if (!decision.ok) throw new AdminUserStoreError(decision.reason, 409);
  }

  /**
   * 계정 상태와 비밀번호를 바꾼다. 비활성화와 비밀번호 변경은 그 계정의 모든 세션을 폐기한다.
   *
   * @param {string} id
   * @param {{ status?: "active"|"disabled", passwordHash?: string, reason?: string }} change
   * @returns {Promise<{ before: object, after: object, revokedSessions: number }>}
   */
  async updateUser(id, { status, passwordHash }) {
    return this.transaction(async (client) => {
      const { owners, user } = await this.#lockForChange(client, id);
      if (status === "disabled") AdminUserStore.#guardOwner(owners, id, true);
      await client.query(
        `UPDATE ${USERS} SET status = COALESCE($2, status), password_hash = COALESCE($3, password_hash), updated_at = now()
          WHERE id = $1`, [id, status ?? null, passwordHash ?? null]);
      const revoke = status === "disabled" || Boolean(passwordHash);
      const revokedSessions = revoke ? await this.#revokeUserSessions(client, id, status === "disabled" ? "user_disabled" : "password_changed") : 0;
      return { before: publicUser(user), after: await this.getUser(id, client), revokedSessions };
    });
  }

  /**
   * 역할 바인딩을 통째로 바꾼다. 권한 변경이므로 그 계정의 모든 세션을 폐기한다(호출자가 자기 세션이면 회전한다).
   *
   * @param {string} id
   * @param {Array<{ role: string, workspace: string|null }>} bindings
   * @param {{ createdBy: string }} args
   * @returns {Promise<{ before: object, after: object, revokedSessions: number }>}
   */
  async setRoles(id, bindings, { createdBy }) {
    return this.transaction(async (client) => {
      const { owners, user } = await this.#lockForChange(client, id);
      AdminUserStore.#guardOwner(owners, id, roleChangeRemovesOwner(user.bindings, bindings));
      await client.query(`DELETE FROM ${BINDINGS} WHERE user_id = $1`, [id]);
      await this.#insertBindings(client, id, bindings, createdBy);
      await client.query(`UPDATE ${USERS} SET updated_at = now() WHERE id = $1`, [id]);
      const revokedSessions = await this.#revokeUserSessions(client, id, "privilege_changed");
      return { before: publicUser(user), after: await this.getUser(id, client), revokedSessions };
    });
  }

  /**
   * 계정을 지운다. 세션, 바인딩, 복구 코드, 외부 신원은 외래 키로 함께 지워진다.
   *
   * @param {string} id
   * @returns {Promise<{ before: object }>}
   */
  async deleteUser(id) {
    return this.transaction(async (client) => {
      const { owners, user } = await this.#lockForChange(client, id);
      AdminUserStore.#guardOwner(owners, id, hasGlobalOwner(user.bindings));
      await client.query(`DELETE FROM ${USERS} WHERE id = $1`, [id]);
      return { before: publicUser(user) };
    });
  }

  /** 계정 마지막 로그인 시각과(필요하면) 새 비밀번호 해시를 기록한다. */
  async recordLogin(id, { passwordHash = null } = {}) {
    await this.pool.query(
      `UPDATE ${USERS} SET last_login_at = now(), password_hash = COALESCE($2, password_hash) WHERE id = $1`, [id, passwordHash]);
  }

  /* ---------------- 세션 ---------------- */

  /**
   * 세션 행을 넣는다.
   *
   * @param {object} row admin-session-policy.newSessionValues().row
   */
  async insertSession(row, db = this.pool) {
    await db.query(
      `INSERT INTO ${SESSIONS} (id, family_id, user_id, token_hash, csrf_hash, created_at, last_seen_at, absolute_expires_at, created_ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [row.id, row.family_id, row.user_id, row.token_hash, row.csrf_hash, row.created_at, row.last_seen_at,
        row.absolute_expires_at, row.created_ip ?? null]);
  }

  /**
   * 토큰 해시로 세션과 계정 상태, 바인딩을 찾는다.
   *
   * @param {string} tokenHash
   * @returns {Promise<object|null>}
   */
  async findSession(tokenHash) {
    const { rows } = await this.pool.query(
      `SELECT s.id, s.family_id, s.user_id, s.csrf_hash, s.created_at, s.last_seen_at, s.absolute_expires_at,
              s.revoked_at, s.revoke_reason, s.created_ip, u.username, u.status AS user_status, ${BINDINGS_JSON}
         FROM ${SESSIONS} s JOIN ${USERS} u ON u.id = s.user_id
        WHERE s.token_hash = $1`, [tokenHash]);
    return rows[0] ?? null;
  }

  /** 마지막 사용 시각을 기록한다(폐기되지 않은 세션만). */
  async touchSession(id, now) {
    await this.pool.query(`UPDATE ${SESSIONS} SET last_seen_at = $2 WHERE id = $1 AND revoked_at IS NULL`, [id, new Date(now)]);
  }

  /**
   * 세션을 회전한다. 옛 세션이 이미 폐기됐으면 false이고 새 행을 넣지 않는다.
   *
   * @param {string} oldId
   * @param {object} row 새 세션 행(같은 계열)
   * @returns {Promise<boolean>}
   */
  async rotateSession(oldId, row) {
    return this.transaction(async (client) => {
      const { rowCount } = await client.query(
        `UPDATE ${SESSIONS} SET revoked_at = now(), revoke_reason = 'rotated' WHERE id = $1 AND revoked_at IS NULL`, [oldId]);
      if (rowCount === 0) return false;
      await this.insertSession(row, client);
      return true;
    });
  }

  /** 세션 하나를 폐기한다. */
  async revokeSession(id, reason) {
    const { rowCount } = await this.pool.query(
      `UPDATE ${SESSIONS} SET revoked_at = now(), revoke_reason = $2 WHERE id = $1 AND revoked_at IS NULL`, [id, reason]);
    return rowCount;
  }

  /** 계열의 모든 세션을 폐기한다. */
  async revokeFamily(familyId, reason) {
    const { rowCount } = await this.pool.query(
      `UPDATE ${SESSIONS} SET revoked_at = now(), revoke_reason = $2 WHERE family_id = $1 AND revoked_at IS NULL`, [familyId, reason]);
    return rowCount;
  }

  async #revokeUserSessions(db, userId, reason) {
    const { rowCount } = await db.query(
      `UPDATE ${SESSIONS} SET revoked_at = now(), revoke_reason = $2 WHERE user_id = $1 AND revoked_at IS NULL`, [userId, reason]);
    return rowCount;
  }

  /** 계정의 모든 세션을 폐기한다. */
  async revokeUserSessions(userId, reason) {
    return this.#revokeUserSessions(this.pool, userId, reason);
  }

  /**
   * 모든 계정의 모든 세션을 폐기한다(비상 복구).
   *
   * @param {string} reason
   * @param {import("pg").PoolClient|import("pg").Pool} [db]
   * @returns {Promise<number>}
   */
  async revokeAllSessions(reason, db = this.pool) {
    const { rowCount } = await db.query(
      `UPDATE ${SESSIONS} SET revoked_at = now(), revoke_reason = $1 WHERE revoked_at IS NULL`, [reason]);
    return rowCount;
  }

  /* ---------------- TOTP와 복구 코드 ---------------- */

  /** TOTP 등록을 시작한다(봉인한 임시 비밀과 등록 토큰 해시, 만료). */
  async startTotpEnrollment(userId, { pendingSealed, tokenHash, expiresAt }) {
    await this.pool.query(
      `UPDATE ${USERS} SET totp_pending_sealed = $2, totp_enroll_token_hash = $3, totp_enroll_expires_at = $4, updated_at = now()
        WHERE id = $1`, [userId, pendingSealed, tokenHash, expiresAt]);
  }

  /**
   * 등록 토큰 해시로 진행 중인 등록을 찾는다(만료 전, 활성 계정, 아직 등록 전).
   *
   * @param {string} tokenHash
   * @param {number} now
   * @returns {Promise<object|null>}
   */
  async findEnrollment(tokenHash, now) {
    const { rows } = await this.pool.query(
      `SELECT u.id, u.username, u.totp_pending_sealed, ${BINDINGS_JSON}
         FROM ${USERS} u
        WHERE u.totp_enroll_token_hash = $1 AND u.totp_enroll_expires_at > $2 AND u.status = 'active'
          AND u.totp_secret_sealed IS NULL`, [tokenHash, new Date(now)]);
    return rows[0] ?? null;
  }

  /**
   * TOTP 등록을 마친다. 등록 토큰이 그대로일 때만 비밀을 옮기고 복구 코드를 새로 넣는다.
   *
   * @param {string} userId
   * @param {{ sealed: string, step: number, tokenHash: string, codeHashes: string[] }} args
   * @returns {Promise<boolean>}
   */
  async completeTotpEnrollment(userId, { sealed, step, tokenHash, codeHashes }) {
    return this.transaction(async (client) => {
      const { rowCount } = await client.query(
        `UPDATE ${USERS}
            SET totp_secret_sealed = $3, totp_enabled_at = now(), totp_last_step = $4,
                totp_pending_sealed = NULL, totp_enroll_token_hash = NULL, totp_enroll_expires_at = NULL, updated_at = now()
          WHERE id = $1 AND totp_enroll_token_hash = $2 AND totp_secret_sealed IS NULL`,
        [userId, tokenHash, sealed, step]);
      if (rowCount === 0) return false;
      await client.query(`DELETE FROM ${CODES} WHERE user_id = $1`, [userId]);
      for (const hash of codeHashes) {
        await client.query(`INSERT INTO ${CODES} (user_id, code_hash) VALUES ($1, $2)`, [userId, hash]);
      }
      return true;
    });
  }

  /**
   * 받은 TOTP 단계를 기록한다. 저장된 단계보다 클 때만 갱신하며, 갱신했으면 true다.
   *
   * @param {string} userId
   * @param {number} step
   * @returns {Promise<boolean>}
   */
  async consumeTotpStep(userId, step) {
    const { rowCount } = await this.pool.query(
      `UPDATE ${USERS} SET totp_last_step = $2 WHERE id = $1 AND (totp_last_step IS NULL OR totp_last_step < $2)`, [userId, step]);
    return rowCount === 1;
  }

  /** 현재 키로 다시 봉인한 값을 기록한다(봉인 값이 그대로일 때만). */
  async resealTotp(userId, previous, sealed) {
    await this.pool.query(`UPDATE ${USERS} SET totp_secret_sealed = $3 WHERE id = $1 AND totp_secret_sealed = $2`, [userId, previous, sealed]);
  }

  /**
   * 복구 코드 하나를 쓴다. 쓰지 않은 코드면 true다.
   *
   * @param {string} userId
   * @param {string} codeHash
   * @returns {Promise<boolean>}
   */
  async consumeRecoveryCode(userId, codeHash) {
    const { rowCount } = await this.pool.query(
      `UPDATE ${CODES} SET used_at = now() WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL`, [userId, codeHash]);
    return rowCount === 1;
  }

  /**
   * TOTP를 초기화한다(봉인 비밀, 단계, 진행 중인 등록, 복구 코드를 지운다). 계정이 없으면 false.
   *
   * @param {string} userId
   * @param {import("pg").PoolClient|import("pg").Pool} [db]
   * @returns {Promise<boolean>}
   */
  async resetTotp(userId, db = this.pool) {
    const { rowCount } = await db.query(
      `UPDATE ${USERS}
          SET totp_secret_sealed = NULL, totp_enabled_at = NULL, totp_last_step = NULL, totp_pending_sealed = NULL,
              totp_enroll_token_hash = NULL, totp_enroll_expires_at = NULL, updated_at = now()
        WHERE id = $1`, [userId]);
    if (rowCount === 0) return false;
    await db.query(`DELETE FROM ${CODES} WHERE user_id = $1`, [userId]);
    return true;
  }

  /**
   * 계정 이름(중복 판정 값)으로 id를 찾는다.
   *
   * @param {string} norm
   * @param {import("pg").PoolClient|import("pg").Pool} [db]
   * @returns {Promise<string|null>}
   */
  async findUserId(norm, db = this.pool) {
    const { rows } = await db.query(`SELECT id FROM ${USERS} WHERE username_norm = $1`, [norm]);
    return rows[0]?.id ?? null;
  }
}
