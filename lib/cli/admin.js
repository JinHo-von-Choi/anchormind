/**
 * CLI: admin - 관리자 계정 비상 복구
 *
 * 서브명령:
 *   recover [--user NAME] [--confirm] [--json]
 *     모든 관리자 계정 세션을 폐기하고, --user를 주면 그 계정의 TOTP와 복구 코드를 초기화한다(다음 로그인에서 다시 등록).
 *     같은 트랜잭션에서 감사 이벤트 admin.recover(detail.priority high)를 outbox에 남긴다. 서버가 떠 있으면 outbox
 *     작업자가 감사 체인에 옮긴다. 마스터 키 로그인은 이 명령과 관계없이 그대로 동작한다.
 *
 * 로컬 전용이며 DB에 직접 붙는다. 접속 대상은 --url 또는 표준 PG 환경 변수(PGHOST, PGPORT, PGDATABASE, PGUSER,
 * PGPASSWORD)로만 받는다. 환경 파일(.env)은 읽지 않으며(bin/memento.js가 이 명령에서는 dotenv를 불러오지 않는다),
 * 설정 모듈과 서버 DB 모듈을 가져오지 않는다. 대상이 없으면 연결하지 않고 거부한다. --confirm이 없으면 연결 없이
 * 할 일만 출력한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */

import { AdminUserStore }                  from "../admin/AdminUserStore.js";
import { normalizeUsername }               from "../admin/admin-user-rules.js";
import { AUDIT_TOPIC, buildAuditPayload }  from "../logging/audit-event.js";
import { SCHEMA }                          from "../memory/schema.js";
import { resolveTarget, OnlineIndexUsageError } from "../../scripts/ops/online-index-plan.mjs";

export const RECOVER_ACTION = "admin.recover";

export const usage = [
  "Usage: anchormind admin recover [options]",
  "",
  "Emergency recovery for admin accounts (direct database access, the server does not need to run).",
  "Revokes every admin account session and, with --user, resets that account's TOTP and recovery codes.",
  "Records the audit event admin.recover (priority high). The master key login is not affected.",
  "",
  "Target (required; the .env file is never read):",
  "  --url <postgres://user:pass@host:port/db>   or PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD",
  "",
  "Options:",
  "  --user <username>   Reset the TOTP and recovery codes of this account",
  "  --confirm           Apply the changes (without it, print the plan and do not connect)",
  "  --json              Print the result as JSON",
].join("\n");

/** 명령 사용 오류(대상 없음, 인자 오류, 없는 계정) */
export class AdminCliError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = "AdminCliError";
  }
}

const OUTBOX_INSERT = `INSERT INTO ${SCHEMA}.outbox_events (topic, aggregate_id, payload) VALUES ($1, $2, $3::jsonb) RETURNING id`;

/**
 * 접속 대상. --url 또는 PG 환경 변수만 쓴다.
 *
 * @param {object} args
 * @param {Record<string, string|undefined>} env
 * @returns {{ config: object, label: string }}
 */
export function recoverTarget(args, env) {
  try {
    return resolveTarget({ url: typeof args.url === "string" ? args.url : undefined }, env);
  } catch (err) {
    if (err instanceof OnlineIndexUsageError) throw new AdminCliError(`접속 대상이 없다: ${err.message}`);
    throw err;
  }
}

/**
 * 할 일 목록(출력용).
 *
 * @param {{ label: string }} target
 * @param {string|null} username
 * @returns {string[]}
 */
export function recoverPlan(target, username) {
  return [
    `target : ${target.label}`,
    "  1. revoke every admin account session",
    username ? `  2. reset TOTP and recovery codes of account ${username}` : "  2. (no --user: TOTP unchanged)",
    `  3. record audit event ${RECOVER_ACTION} (priority high) in the outbox`
  ];
}

/**
 * 복구를 한 트랜잭션으로 실행한다.
 *
 * @param {AdminUserStore} store
 * @param {{ norm: string|null, username: string|null }} user
 * @returns {Promise<{ revokedSessions: number, userId: string|null, outboxId: string }>}
 */
export async function runRecover(store, user) {
  return store.transaction(async (client) => {
    let userId = null;
    if (user.norm) {
      userId = await store.findUserId(user.norm, client);
      if (!userId) throw new AdminCliError(`account not found: ${user.username}`);
      await store.resetTotp(userId, client);
    }
    const revokedSessions = await store.revokeAllSessions("emergency_recover", client);
    const payload = buildAuditPayload({
      action: RECOVER_ACTION,
      actor : "system",
      target: userId ? { type: "admin_user", id: userId } : null,
      detail: { priority: "high", channel: "cli", totpReset: Boolean(userId), revokedSessions }
    });
    const aggregate = userId ? `admin_user:${userId}` : "admin_user";
    const { rows } = await client.query(OUTBOX_INSERT, [AUDIT_TOPIC, aggregate, JSON.stringify(payload)]);
    return { revokedSessions, userId, outboxId: String(rows[0].id) };
  });
}

/**
 * pg 풀을 만든다.
 *
 * @param {object} config
 * @returns {Promise<import("pg").Pool>}
 */
async function defaultConnect(config) {
  const { default: pg } = await import("pg");
  return new pg.Pool({ ...config, max: 2 });
}

/**
 * @param {object} args parseArgs 결과
 * @param {{ env?: Record<string, string|undefined>, connect?: Function, out?: Function, err?: Function }} [deps]
 */
export default async function admin(args, { env = {}, connect = defaultConnect, out = console.log, err = console.error } = {}) {
  const sub = args._?.[0];
  if (sub !== "recover") throw new AdminCliError(`unknown admin subcommand: ${sub ?? "(none)"}. Run "anchormind admin --help"`);
  const user   = args.user === undefined ? { norm: null, username: null } : normalizeUsername(String(args.user));
  const target = recoverTarget(args, env);
  const plan   = recoverPlan(target, user.username);

  if (args.confirm !== true) {
    out([...plan, "", "Nothing changed. Run again with --confirm to apply."].join("\n"));
    return { applied: false };
  }

  const pool = await connect(target.config);
  let result;
  try {
    result = await runRecover(new AdminUserStore(pool), user);
  } finally {
    await pool.end();
  }
  err(`[admin recover] audit event ${RECOVER_ACTION} (priority high) recorded in the outbox (id ${result.outboxId})`);
  if (args.json) out(JSON.stringify({ applied: true, ...result }, null, 2));
  else out([...plan, "", `revoked sessions: ${result.revokedSessions}`, `totp reset     : ${result.userId ? "yes" : "no"}`].join("\n"));
  return { applied: true, ...result };
}
