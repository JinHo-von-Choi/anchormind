/**
 * API 키 이중 조회와 수명 판정 시험(저장소 대체)
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * DB 풀만 대체하고 실제 ApiKeyStore를 거친다.
 *   - 원시 키 조회는 한 문장에서 api_key_secrets를 먼저 보고, 그 해시가 없을 때만 api_keys.key_hash를 본다
 *   - 운영 형태의 키 상태(활성/비활성, 한도 미만/도달, 비밀 행 유무)에서 인증 결과가 이전 판정과 같다
 *   - 만료, 폐기, 회전 겹침 종료가 거부 사유로 나온다
 *   - 수명 스키마가 없으면 이전 판 질의로 같은 결과를 낸다
 *   - 마지막 사용 기록은 키별 간격 안에서 한 번만 쓴다(쓰기 수 측정)
 */
import { describe, it, mock, beforeEach } from "node:test";
import assert                              from "node:assert/strict";

const KEY_ID = "7a1e0000-0000-4000-8000-0000000000e5";

let rowsFor;
let sqls;

const pool = {
  query: async (sql, params = []) => {
    sqls.push({ sql, params });
    return rowsFor(sql, params);
  }
};

mock.module("../../lib/tools/db.js", { exports: { getPrimaryPool: () => pool } });

const {
  validateApiKeyFromDB, validateApiKeyById, getKeyAuthState, incrementUsage, createApiKey, resetLastUsedThrottle
} = await import("../../lib/admin/ApiKeyStore.js");
const { resetLifecycleSchemaState } = await import("../../lib/admin/key-schema-state.js");
const { hashClientIp }              = await import("../../lib/admin/key-lifecycle.js");

const IP_HASH = hashClientIp("10.0.0.1", "pepper");

const isLookup  = (sql) => /WHERE\s+s\.key_hash\s*=\s*\$1/.test(sql);
const isLegacy  = (sql) => /WHERE k\.key_hash = \$1/.test(sql);
const isGroups  = (sql) => /api_key_group_members m1/.test(sql);

/** 이전 판 판정(api_keys 한 행만 보던 규칙) */
function legacyDecision(row) {
  if (!row) return { valid: false };
  if (row.status !== "active") return { valid: false, reason: "inactive" };
  if (row.usage_today >= row.daily_limit) return { valid: false, reason: "limit_exceeded" };
  return { valid: true };
}

function keyRow(extra = {}) {
  return {
    id: KEY_ID, name: "k", permissions: ["read"], status: "active", daily_limit: 10, fragment_limit: null,
    default_workspace: null, default_mode: null, usage_today: 0,
    expires_at: null, revoked_at: null, allowed_cidrs: null,
    secret_source: "secret", secret_status: "active", secret_valid_until: null,
    ...extra
  };
}

const outcome = (r) => (r.valid ? { valid: true } : (r.reason ? { valid: false, reason: r.reason } : { valid: false }));

beforeEach(() => {
  sqls = [];
  resetLifecycleSchemaState();
  resetLastUsedThrottle();
  rowsFor = async () => ({ rows: [], rowCount: 0 });
});

describe("원시 키 조회 순서", () => {
  it("비밀 표를 먼저 보고, 그 해시가 없을 때만 api_keys를 보는 한 문장이다", async () => {
    await validateApiKeyFromDB("mmcp_x_0123");
    assert.equal(sqls.length, 1);
    const sql = sqls[0].sql;
    const secretAt = sql.indexOf("api_key_secrets s");
    const legacyAt = sql.indexOf("api_keys l");
    assert.ok(secretAt > 0 && legacyAt > secretAt, "비밀 표 조회가 앞에 온다");
    assert.match(sql, /UNION ALL/);
    assert.match(sql, /NOT EXISTS\s*\(SELECT 1 FROM agent_memory\.api_key_secrets x WHERE x\.key_hash = \$1\)/);
    assert.match(sqls[0].params[0], /^[0-9a-f]{64}$/, "원시 키가 아니라 해시를 넘긴다");
    assert.ok(!sqls[0].params.includes("mmcp_x_0123"));
  });
});

describe("운영 형태 키 상태의 인증 결과 차분", () => {
  const states = [];
  for (const status of ["active", "inactive"]) {
    for (const usage of [0, 9, 10, 50]) {
      for (const source of ["secret", "legacy", null]) states.push({ status, usage, source });
    }
  }

  for (const s of states) {
    it(`status=${s.status} usage=${s.usage} source=${s.source}`, async () => {
      const row = s.source === null ? null : keyRow({
        status: s.status, usage_today: s.usage,
        secret_source: s.source, secret_status: s.source === "secret" ? "active" : null
      });
      rowsFor = async (sql) => {
        if (isLookup(sql)) return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
        if (isGroups(sql)) return { rows: [] };
        return { rows: [] };
      };
      const result = await validateApiKeyFromDB("mmcp_k_raw");
      assert.deepEqual(outcome(result), legacyDecision(row));
      if (result.valid) {
        assert.equal(result.keyId, KEY_ID);
        assert.deepEqual(result.permissions, ["read"]);
        assert.equal(result.allowedCidrs, null);
      }
    });
  }
});

describe("수명 거부 사유", () => {
  const cases = [
    [{ expires_at: new Date(Date.now() - 1000) }, "expired"],
    [{ revoked_at: new Date(), status: "inactive", secret_status: "revoked" }, "revoked"],
    [{ secret_valid_until: new Date(Date.now() - 1000) }, "rotated"],
    [{ secret_status: "revoked" }, "revoked"]
  ];
  for (const [extra, reason] of cases) {
    it(reason + " " + Object.keys(extra).join(","), async () => {
      rowsFor = async (sql) => (isLookup(sql) ? { rows: [keyRow(extra)], rowCount: 1 } : { rows: [] });
      assert.deepEqual(await validateApiKeyFromDB("mmcp_k_raw"), { valid: false, reason });
    });
  }

  it("겹침 안의 이전 비밀과 만료 전 키는 통과하고 허용 대역을 함께 돌려준다", async () => {
    rowsFor = async (sql) => (isLookup(sql)
      ? { rows: [keyRow({ secret_valid_until: new Date(Date.now() + 60_000), expires_at: new Date(Date.now() + 60_000), allowed_cidrs: ["10.0.0.0/8"] })], rowCount: 1 }
      : { rows: [] });
    const result = await validateApiKeyFromDB("mmcp_k_raw");
    assert.equal(result.valid, true);
    assert.deepEqual(result.allowedCidrs, ["10.0.0.0/8"]);
  });
});

describe("수명 스키마가 없는 DB", () => {
  const missing = () => Object.assign(new Error('relation "agent_memory.api_key_secrets" does not exist'), { code: "42P01" });

  it("이전 판 질의로 같은 결과를 내고 재시도 간격 동안 수명 판을 건너뛴다", async () => {
    rowsFor = async (sql) => {
      if (isLookup(sql)) throw missing();
      if (isLegacy(sql)) return { rows: [{ ...keyRow(), expires_at: undefined }], rowCount: 1 };
      return { rows: [] };
    };
    const first = await validateApiKeyFromDB("mmcp_k_raw");
    assert.equal(first.valid, true);
    const lookups = sqls.filter((q) => isLookup(q.sql)).length;
    await validateApiKeyFromDB("mmcp_k_raw");
    assert.equal(sqls.filter((q) => isLookup(q.sql)).length, lookups, "간격 안에서는 수명 판을 다시 시도하지 않는다");
    assert.equal(sqls.filter((q) => isLegacy(q.sql)).length, 2);
  });

  it("그 밖의 오류는 그대로 던진다", async () => {
    rowsFor = async () => { throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }); };
    await assert.rejects(validateApiKeyFromDB("mmcp_k_raw"), { code: "ECONNREFUSED" });
  });
});

describe("id 조회와 세션 재확인 상태", () => {
  it("id 조회는 만료와 폐기를 거부한다", async () => {
    rowsFor = async () => ({ rows: [{ ...keyRow(), expires_at: new Date(Date.now() - 1) }] });
    assert.deepEqual(await validateApiKeyById(KEY_ID), { valid: false, reason: "expired" });
    rowsFor = async () => ({ rows: [{ ...keyRow(), revoked_at: new Date(), status: "inactive" }] });
    assert.deepEqual(await validateApiKeyById(KEY_ID), { valid: false, reason: "revoked" });
  });

  it("id 조회는 허용 대역을 함께 돌려준다", async () => {
    rowsFor = async (sql) => (isGroups(sql) ? { rows: [] } : { rows: [{ ...keyRow(), allowed_cidrs: ["::1/128"] }] });
    const result = await validateApiKeyById(KEY_ID);
    assert.equal(result.valid, true);
    assert.deepEqual(result.allowedCidrs, ["::1/128"]);
  });

  it("세션 재확인 상태에 폐기, 만료, 허용 대역이 실린다", async () => {
    const expires = new Date(Date.now() + 1000);
    rowsFor = async () => ({ rows: [{ status: "active", permissions: ["read"], revoked_at: null, expires_at: expires, allowed_cidrs: ["10.0.0.0/8"] }] });
    assert.deepEqual(await getKeyAuthState(KEY_ID), {
      exists: true, status: "active", permissions: ["read"], revokedAt: null, expiresAt: expires, allowedCidrs: ["10.0.0.0/8"]
    });
  });
});

describe("키 생성", () => {
  it("api_keys와 api_key_secrets를 한 문장으로 쓰고 원시 키는 해시만 넘긴다", async () => {
    rowsFor = async (sql, params) => ({ rows: [{ id: KEY_ID, name: params[0], permissions: params[3] }], rowCount: 1 });
    const key = await createApiKey({ name: "svc", permissions: ["read"], daily_limit: 5 });
    assert.equal(sqls.length, 1);
    assert.match(sqls[0].sql, /INSERT INTO agent_memory\.api_keys/);
    assert.match(sqls[0].sql, /INSERT INTO agent_memory\.api_key_secrets/);
    assert.ok(!sqls[0].params.includes(key.raw_key), "원시 키는 질의 값에 없다");
  });
});

describe("마지막 사용 기록 쓰기 수(측정)", () => {
  const countWrites = () => ({
    usage   : sqls.filter((q) => /INSERT INTO agent_memory\.api_key_usage/.test(q.sql)).length,
    lastUsed: sqls.filter((q) => /SET\s+last_used_at = NOW\(\)/.test(q.sql)).length
  });

  it("기본 간격(60초)에서 같은 키의 요청 100건은 사용량 100건, 마지막 사용 1건을 쓴다", async () => {
    for (let i = 0; i < 100; i++) incrementUsage(KEY_ID, IP_HASH);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(countWrites(), { usage: 100, lastUsed: 1 });
    const update = sqls.find((q) => /SET\s+last_used_at = NOW\(\)/.test(q.sql));
    assert.equal(update.params[1], IP_HASH);
  });

  it("간격 0이면 요청마다 마지막 사용을 쓴다", async () => {
    process.env.MEMENTO_KEY_LAST_USED_INTERVAL_SEC = "0";
    try {
      for (let i = 0; i < 100; i++) incrementUsage(KEY_ID, IP_HASH);
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(countWrites(), { usage: 100, lastUsed: 100 });
    } finally {
      delete process.env.MEMENTO_KEY_LAST_USED_INTERVAL_SEC;
    }
  });
});
