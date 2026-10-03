/**
 * API 키 수명 실서버 시험(일회용 DB)
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * migration-059의 api_key_secrets와 수명 열에서 다음을 본다.
 *   - api_keys 행만 있는 키의 인증 결과가 해시 이관 전후로 같다(활성, 비활성, 한도 도달)
 *   - 이관 스크립트가 모든 키를 옮기고 정합(활성 키 수 = 활성 현재 비밀 행 수)을 확인하며, 다시 실행해도 행이 늘지 않는다
 *   - 이관 뒤 api_keys에만 들어온 키도 이중 조회로 인증된다
 *   - 새 키는 두 표에 함께 쓰인다
 *   - 회전 겹침 동안 이전 키와 새 키가 모두 인증되고, 겹침이 끝나면 이전 키만 거부된다. 겹침 0은 즉시 거부다
 *   - 폐기는 모든 비밀을 거부하고 세션 재확인 상태에 반영되며 다시 활성화할 수 없다
 *   - 만료 시각이 지난 키를 거부한다
 *   - 같은 키의 동시 회전은 직렬화되어 현재 해시가 하나로 남는다
 *   - 겹침이 끝나면 그보다 먼저 만든 세션과 OAuth 토큰이 끝나는 판정 값(퇴역 시각)이 세션 상태와 id 조회에 실린다
 *   - 이관이 진행 중인 폐기와 겹쳐도 폐기한 키에 활성 비밀 행을 만들지 않는다
 *   - 비밀 표가 있는데 수명 열이 없으면 새 프로세스에서도 기본 판으로 내려가지 않고 거부한다
 *   - 수명 판이 한 번 성공한 뒤 비밀 표가 사라지면 기본 판으로 내려가지 않고 거부한다(마지막 시험)
 * 실행마다 전용 데이터베이스를 만들어 쓰고 끝나면 지운다.
 */
import { describe, it, after } from "node:test";
import assert                  from "node:assert/strict";
import crypto                  from "node:crypto";
import pg                      from "pg";

const { prepareLaneDatabase, dropLaneDatabase, directQuery, directClientConfig, laneDatabaseName } = await import("./_harness.js");

/** 앱 모듈이 풀을 만들기 전에 실행 전용 데이터베이스를 준비한다. */
await prepareLaneDatabase();

const { shutdownPool } = await import("../../lib/tools/db.js");
const {
  validateApiKeyFromDB, createApiKey, getKeyAuthState, updateApiKeyStatus
} = await import("../../lib/admin/ApiKeyStore.js");
const {
  rotateApiKey, revokeApiKey, updateKeyLifecycle
} = await import("../../lib/admin/ApiKeyLifecycleStore.js");
const { isKeyStateRevoked } = await import("../../lib/admin/key-state-cache.js");
const { validateApiKeyById } = await import("../../lib/admin/ApiKeyStore.js");
const { isAccessRetired }    = await import("../../lib/admin/key-lifecycle.js");
const { resetLifecycleSchemaState } = await import("../../lib/admin/key-schema-state.js");
const { main: backfillMain } = await import("../../scripts/ops/backfill-key-secrets.mjs");

const KEYS    = "agent_memory.api_keys";
const SECRETS = "agent_memory.api_key_secrets";

const sha256  = (raw) => crypto.createHash("sha256").update(raw).digest("hex");
const outcome = (r) => (r.valid ? "valid" : (r.reason ?? "unknown"));

/** api_keys 행만 있는 키를 만든다(비밀 표 행 없음). */
async function legacyKey(name, { status = "active", dailyLimit = 10, usage = 0 } = {}) {
  const raw = `mmcp_${name}_${crypto.randomBytes(16).toString("hex")}`;
  const { rows: [row] } = await directQuery(
    `INSERT INTO ${KEYS} (name, key_hash, key_prefix, permissions, status, daily_limit) VALUES ($1, $2, $3, '{read,write}', $4, $5) RETURNING id`,
    [name, sha256(raw), raw.slice(0, 14), status, dailyLimit]
  );
  if (usage > 0) {
    await directQuery("INSERT INTO agent_memory.api_key_usage (key_id, usage_date, call_count) VALUES ($1, CURRENT_DATE, $2)", [row.id, usage]);
  }
  return { id: row.id, raw };
}

async function runBackfill(argv) {
  const out = [];
  const err = [];
  const code = await backfillMain(argv, {}, {
    connect: async () => { const c = new pg.Client(directClientConfig()); await c.connect(); return c; },
    out    : (l) => out.push(l),
    err    : (l) => err.push(l)
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const laneUrl = () => `postgresql://memento@localhost:35433/${laneDatabaseName()}`;

after(async () => {
  try {
    await shutdownPool();
  } finally {
    await dropLaneDatabase();
  }
});

describe("api_keys 행만 있는 키의 해시 이관과 이중 조회", () => {
  it("이관 전후 인증 결과가 같고, 이관은 정합을 확인하며 멱등이다", async () => {
    const keys = {
      active  : await legacyKey("active"),
      inactive: await legacyKey("inactive", { status: "inactive" }),
      limited : await legacyKey("limited", { dailyLimit: 3, usage: 3 }),
      under   : await legacyKey("under", { dailyLimit: 3, usage: 2 })
    };
    const expected = { active: "valid", inactive: "inactive", limited: "limit_exceeded", under: "valid" };

    for (const [name, key] of Object.entries(keys)) {
      assert.equal(outcome(await validateApiKeyFromDB(key.raw)), expected[name], `이관 전 ${name}`);
    }
    assert.equal(outcome(await validateApiKeyFromDB("mmcp_unknown_00")), "unknown");

    const dry = await runBackfill(["--url", laneUrl()]);
    assert.equal(dry.code, 0, dry.err);
    assert.match(dry.out, /옮길 키 4건/);
    assert.equal((await directQuery(`SELECT count(*)::int AS n FROM ${SECRETS}`)).rows[0].n, 0, "기본 모드는 쓰지 않는다");

    const applied = await runBackfill(["--confirm", "--url", laneUrl()]);
    assert.equal(applied.code, 0, applied.err);
    assert.match(applied.out, /옮긴 키 4건/);
    assert.match(applied.out, /정합: 일치/);

    const { rows: [counts] } = await directQuery(
      `SELECT (SELECT count(*) FROM ${KEYS} WHERE status = 'active' AND revoked_at IS NULL)::int AS active_keys,
              (SELECT count(*) FROM ${SECRETS} s JOIN ${KEYS} k ON k.id = s.key_id AND k.key_hash = s.key_hash
                WHERE s.status = 'active' AND k.status = 'active')::int AS active_secrets`);
    assert.equal(counts.active_secrets, counts.active_keys);

    const again = await runBackfill(["--confirm", "--url", laneUrl()]);
    assert.equal(again.code, 0, again.err);
    assert.match(again.out, /옮긴 키 0건/);
    assert.equal((await directQuery(`SELECT count(*)::int AS n FROM ${SECRETS}`)).rows[0].n, 4);

    for (const [name, key] of Object.entries(keys)) {
      assert.equal(outcome(await validateApiKeyFromDB(key.raw)), expected[name], `이관 후 ${name}`);
    }
  });

  it("이관 뒤 api_keys에만 들어온 키도 인증된다", async () => {
    const late = await legacyKey("late");
    assert.equal(outcome(await validateApiKeyFromDB(late.raw)), "valid");
    const { rows } = await directQuery(`SELECT 1 FROM ${SECRETS} WHERE key_id = $1`, [late.id]);
    assert.equal(rows.length, 0);
  });

  it("새 키는 두 표에 함께 쓰이고 비밀 표로 인증된다", async () => {
    const created = await createApiKey({ name: "fresh", permissions: ["read"], daily_limit: 100, allowed_cidrs: ["198.51.100.0/24"] });
    const { rows } = await directQuery(`SELECT s.key_hash, k.key_hash AS current, k.allowed_cidrs FROM ${SECRETS} s JOIN ${KEYS} k ON k.id = s.key_id WHERE k.id = $1`, [created.id]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].key_hash, rows[0].current);
    assert.deepEqual(rows[0].allowed_cidrs, ["198.51.100.0/24"]);
    const result = await validateApiKeyFromDB(created.raw_key);
    assert.equal(result.valid, true);
    assert.deepEqual(result.allowedCidrs, ["198.51.100.0/24"]);
  });
});

describe("회전 겹침", () => {
  it("겹침 동안 두 키가 인증되고, 겹침이 끝나면 이전 키만 rotated로 거부된다", async () => {
    const key     = await legacyKey("rotor");
    const rotated = await rotateApiKey(key.id, { graceHours: 1 });
    assert.equal(outcome(await validateApiKeyFromDB(key.raw)), "valid");
    assert.equal(outcome(await validateApiKeyFromDB(rotated.raw_key)), "valid");
    assert.equal((await directQuery(`SELECT key_hash FROM ${KEYS} WHERE id = $1`, [key.id])).rows[0].key_hash, sha256(rotated.raw_key));

    await directQuery(`UPDATE ${SECRETS} SET valid_until = NOW() - interval '1 second' WHERE key_hash = $1`, [sha256(key.raw)]);
    assert.equal(outcome(await validateApiKeyFromDB(key.raw)), "rotated");
    assert.equal(outcome(await validateApiKeyFromDB(rotated.raw_key)), "valid");
  });

  it("겹침 0은 이전 키를 즉시 거부하고, 다음 회전은 앞선 겹침을 새 종료 시각 이하로 줄인다", async () => {
    const key    = await legacyKey("rotor2");
    const first  = await rotateApiKey(key.id, { graceHours: 24 });
    const second = await rotateApiKey(key.id, { graceHours: 0 });
    assert.equal(outcome(await validateApiKeyFromDB(key.raw)), "rotated");
    assert.equal(outcome(await validateApiKeyFromDB(first.raw_key)), "rotated");
    assert.equal(outcome(await validateApiKeyFromDB(second.raw_key)), "valid");
  });

  it("같은 키의 동시 회전은 직렬화되어 현재 해시 하나만 무기한으로 남는다", async () => {
    const key     = await legacyKey("rotor3");
    const results = await Promise.all([1, 2, 3, 4].map(() => rotateApiKey(key.id, { graceHours: 1 })));
    const { rows } = await directQuery(
      `SELECT s.key_hash, s.valid_until, (s.key_hash = k.key_hash) AS current
       FROM ${SECRETS} s JOIN ${KEYS} k ON k.id = s.key_id WHERE k.id = $1`, [key.id]);
    assert.equal(rows.length, 5, "원래 해시와 회전 4번");
    assert.equal(rows.filter((r) => r.current).length, 1);
    assert.equal(rows.filter((r) => r.valid_until === null).length, 1);
    assert.equal(rows.find((r) => r.current).valid_until, null);
    const valid = (await Promise.all(results.map((r) => validateApiKeyFromDB(r.raw_key)))).filter((r) => r.valid).length;
    assert.equal(valid, 4, "겹침 안의 회전 키는 모두 인증된다");
  });
});

describe("겹침 종료 뒤 기존 세션과 토큰", () => {
  it("지난 퇴역 시각이 세션 상태와 id 조회에 실리고 그보다 먼저 만든 접근만 끝난다", async () => {
    const key     = await legacyKey("retiring");
    const before  = Date.now() - 1000;
    await rotateApiKey(key.id, { graceHours: 1 });
    let state = await getKeyAuthState(key.id);
    assert.equal(isKeyStateRevoked(state, { sessionCreatedAt: before }), false, "겹침 중에는 이어진다");

    await directQuery(`UPDATE ${SECRETS} SET valid_until = NOW() - interval '1 second' WHERE key_hash = $1`, [sha256(key.raw)]);
    state = await getKeyAuthState(key.id);
    assert.equal(state.secretRetirements.length, 1);
    assert.equal(isKeyStateRevoked(state, { sessionCreatedAt: before }), true);
    assert.equal(isKeyStateRevoked(state, { sessionCreatedAt: Date.now() }), false);

    const byId = await validateApiKeyById(key.id);
    assert.equal(byId.valid, true);
    assert.equal(isAccessRetired(before, byId.secretRetirements, Date.now()), true);
    assert.equal(isAccessRetired(Date.now(), byId.secretRetirements, Date.now()), false);
  });

  it("겹침 0 회전은 그 시각 이전의 접근을 바로 끝낸다", async () => {
    const key    = await legacyKey("cutnow");
    const before = Date.now() - 1000;
    await rotateApiKey(key.id, { graceHours: 0 });
    assert.equal(isKeyStateRevoked(await getKeyAuthState(key.id), { sessionCreatedAt: before }), true);
  });
});

describe("이관과 폐기의 경합", () => {
  it("폐기 트랜잭션이 키 행을 잡은 동안 시작한 이관은 기다렸다가 revoked 행으로 옮긴다", async () => {
    const key    = await legacyKey("racer");
    const holder = new pg.Client(directClientConfig());
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(`SELECT id FROM ${KEYS} WHERE id = $1 FOR UPDATE`, [key.id]);
      await holder.query(`UPDATE ${KEYS} SET revoked_at = NOW(), revoked_by = 'master:bearer', revoke_reason = 'race', status = 'inactive' WHERE id = $1`, [key.id]);
      const pending = runBackfill(["--confirm", "--url", laneUrl()]);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await holder.query(`UPDATE ${SECRETS} SET status = 'revoked' WHERE key_id = $1`, [key.id]);
      await holder.query("COMMIT");
      const result = await pending;
      assert.equal(result.code, 0, result.err);
      assert.match(result.out, /폐기한 키의 활성 비밀 행 0건/);
    } finally {
      await holder.end();
    }
    const { rows } = await directQuery(`SELECT status FROM ${SECRETS} WHERE key_id = $1`, [key.id]);
    assert.deepEqual(rows.map((r) => r.status), ["revoked"]);
  });
});

describe("폐기와 만료", () => {
  it("폐기는 모든 비밀을 거부하고 세션 상태에 반영되며 다시 활성화할 수 없다", async () => {
    const key     = await legacyKey("revokee");
    const rotated = await rotateApiKey(key.id, { graceHours: 24 });
    const revoked = await revokeApiKey(key.id, { reason: "rotation leak", actor: "master:bearer" });
    assert.equal(revoked.status, "inactive");
    assert.equal(revoked.revoked_secrets, 2);
    assert.equal(outcome(await validateApiKeyFromDB(key.raw)), "revoked");
    assert.equal(outcome(await validateApiKeyFromDB(rotated.raw_key)), "revoked");

    const state = await getKeyAuthState(key.id);
    assert.ok(state.revokedAt instanceof Date);
    assert.equal(isKeyStateRevoked(state), true);

    await assert.rejects(updateApiKeyStatus(key.id, "active"), { code: "key_revoked" });
    await assert.rejects(revokeApiKey(key.id, { reason: "x", actor: "master:bearer" }), { code: "already_revoked" });
    await assert.rejects(rotateApiKey(key.id, { graceHours: 1 }), { code: "key_revoked" });
  });

  it("만료 시각이 지난 키를 거부하고 해제하면 다시 인증된다", async () => {
    const key = await legacyKey("expiring");
    const set = await updateKeyLifecycle(key.id, { expires_at: new Date(Date.now() - 1000).toISOString() });
    assert.equal(set.before.expires_at, null);
    assert.equal(outcome(await validateApiKeyFromDB(key.raw)), "expired");
    await updateKeyLifecycle(key.id, { expires_at: null });
    assert.equal(outcome(await validateApiKeyFromDB(key.raw)), "valid");
  });
});

describe("수명 열이 사라진 DB의 새 프로세스", () => {
  it("비밀 표가 있으면 판정 상태를 처음으로 돌린 뒤에도 기본 판으로 내려가지 않고 거부한다", async () => {
    const key = await legacyKey("columngone");
    await directQuery(`ALTER TABLE ${KEYS} RENAME COLUMN allowed_cidrs TO allowed_cidrs_moved`);
    try {
      resetLifecycleSchemaState();
      await assert.rejects(validateApiKeyFromDB(key.raw), { code: "42703" });
      assert.equal(outcome(await validateApiKeyById(key.id)), "store_unavailable");
    } finally {
      await directQuery(`ALTER TABLE ${KEYS} RENAME COLUMN allowed_cidrs_moved TO allowed_cidrs`);
    }
  });
});

describe("수명 스키마가 사라진 뒤(마지막 시험)", () => {
  it("수명 판이 성공한 뒤 비밀 표가 없어지면 기본 판으로 내려가지 않고 저장소 오류로 거부한다", async () => {
    const key = await legacyKey("schemagone");
    assert.equal(outcome(await validateApiKeyFromDB(key.raw)), "valid");
    await directQuery(`DROP TABLE ${SECRETS}`);
    await assert.rejects(validateApiKeyFromDB(key.raw), { code: "42P01" });
    assert.equal(outcome(await validateApiKeyById(key.id)), "store_unavailable");
  });
});
