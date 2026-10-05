/**
 * PATCH /keys/:id/policy 핸들러 동작 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * DB 풀과 감사 기록기만 대체하고 실제 라우트 표, 검증기, 저장소 함수, 조회 캐시를 거친다.
 */
import { describe, it, mock, beforeEach } from "node:test";
import assert                              from "node:assert/strict";
import { Readable }                        from "node:stream";

process.env.DOTENV_CONFIG_PATH      ??= ".env.test";
process.env.MEMENTO_METRICS_DEFAULT ??= "off";
process.env.REDIS_ENABLED           ??= "false";
process.env.CACHE_ENABLED           ??= "false";

const KEY_ID = "7a1e0000-0000-4000-8000-0000000000e3";

let   row;
let   sqls;
let   poolFailure;
const audits = [];

const pool = {
  query: async (sql, params = []) => {
    sqls.push({ sql: sql.trim(), params });
    if (poolFailure) throw poolFailure;
    if (/^WITH prev AS/.test(sql.trim())) {
      if (!row) return { rows: [], rowCount: 0 };
      const prev = { ...row };
      const assignments = [...sql.matchAll(/(\w+) = \$(\d+)/g)].filter(([, col]) => col in row);
      for (const [, col, idx] of assignments) {
        const value = params[Number(idx) - 1];
        row[col] = col === "egress_policy" && typeof value === "string" ? JSON.parse(value) : value;
      }
      const out = {};
      for (const col of Object.keys(row)) {
        if (!new RegExp(`prev\\.${col} AS prev_${col}`).test(sql)) continue;
        out[`prev_${col}`] = prev[col];
        out[col]           = row[col];
      }
      return { rowCount: 1, rows: [out] };
    }
    if (/to_jsonb\(k\) -> 'egress_policy'/.test(sql)) return { rows: row ? [{ egress_policy: row.egress_policy ?? null }] : [] };
    if (/SELECT symbolic_hard_gate FROM/.test(sql))  return { rows: row ? [{ symbolic_hard_gate: row.symbolic_hard_gate }] : [] };
    if (/SELECT allowed_workspaces FROM/.test(sql))  return { rows: row ? [{ allowed_workspaces: row.allowed_workspaces }] : [] };
    if (/INSERT INTO .*api_keys/.test(sql))          return { rows: [{ id: KEY_ID, name: params[0], permissions: params[3], fragment_limit: params[5] }] };
    return { rows: [], rowCount: 0 };
  }
};

mock.module("../../lib/tools/db.js", { exports: { getPrimaryPool: () => pool } });
mock.module("../../lib/sessions.js", { exports: { closeSessionsByKeyId: async () => 0 } });

const realAudit = await import("../../lib/logging/audit.js");
mock.module("../../lib/logging/audit.js", {
  exports: { ...realAudit, logAudit: async (operation, fields) => { audits.push({ operation, fields }); } }
});

const { handleKeys }                           = await import("../../lib/admin/admin-keys.js");
const { requireCapability, masterPrincipal }   = await import("../../lib/admin/AdminAuthz.js");
const {
  getSymbolicHardGate,
  getAllowedWorkspaces,
  getEgressPolicy,
  invalidateHardGateCache,
  invalidateAllowedWorkspacesCache,
  invalidateEgressPolicyCache
} = await import("../../lib/admin/ApiKeyStore.js");
const ADMIN_BASE = "/v1/internal/model/nothing";

function fakeRes() {
  const chunks = [];
  return {
    statusCode: 0,
    setHeader() {},
    end(body) { if (body) chunks.push(body); },
    get body() { return chunks.length ? JSON.parse(chunks.join("")) : null; }
  };
}

/** 라우터가 하듯 요청에 주체를 묶은 뒤 처리기를 부른다. 기본 주체는 마스터 키다. */
async function call(method, pathname, body, principal = masterPrincipal()) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === "string" ? body : JSON.stringify(body))]);
  req.method  = method;
  req.headers = {};
  const res     = fakeRes();
  requireCapability(req, fakeRes(), { principal, cap: "key.policy" });
  const handled = await handleKeys(req, res, new URL(`http://localhost${ADMIN_BASE}${pathname}`));
  return { res, handled };
}

const patchPolicy = (body, id = KEY_ID) => call("PATCH", `/keys/${id}/policy`, body);
const updates     = () => sqls.filter((s) => /^WITH prev AS/.test(s.sql));

beforeEach(() => {
  row         = { default_mode: null, allowed_workspaces: null, symbolic_hard_gate: false };
  sqls        = [];
  poolFailure = null;
  audits.length = 0;
  invalidateHardGateCache(KEY_ID);
  invalidateAllowedWorkspacesCache(KEY_ID);
  invalidateEgressPolicyCache(KEY_ID);
});

describe("PATCH /keys/:id/policy 정상 경로", () => {
  it("세 열을 한 번에 바꾸고 변경 후 값을 돌려준다", async () => {
    const { res } = await patchPolicy({ default_mode: "recall-only", allowed_workspaces: ["alpha", "beta"], symbolic_hard_gate: true });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { success: true, default_mode: "recall-only", allowed_workspaces: ["alpha", "beta"], symbolic_hard_gate: true });
    assert.equal(updates().length, 1);
    assert.deepEqual(row, { default_mode: "recall-only", allowed_workspaces: ["alpha", "beta"], symbolic_hard_gate: true });
  });

  it("전달하지 않은 열은 갱신문에 넣지 않는다", async () => {
    await patchPolicy({ symbolic_hard_gate: true });
    const [{ sql, params }] = updates();
    assert.doesNotMatch(sql, /default_mode = /);
    assert.doesNotMatch(sql, /allowed_workspaces = /);
    assert.deepEqual(params, [KEY_ID, true]);
  });

  it("null로 mode와 workspace 제한을 해제한다", async () => {
    row = { default_mode: "recall-only", allowed_workspaces: ["alpha"], symbolic_hard_gate: true };
    const { res } = await patchPolicy({ default_mode: null, allowed_workspaces: null });
    assert.equal(res.statusCode, 200);
    assert.equal(row.default_mode, null);
    assert.equal(row.allowed_workspaces, null);
    assert.equal(row.symbolic_hard_gate, true);
  });

  it("빈 배열은 null과 구분해 저장한다", async () => {
    await patchPolicy({ allowed_workspaces: [] });
    assert.deepEqual(row.allowed_workspaces, []);
  });

  it("라우트 표에서 workspace 라우트나 상태 라우트로 가지 않는다", async () => {
    await patchPolicy({ symbolic_hard_gate: true });
    assert.equal(sqls.filter((s) => /default_workspace/.test(s.sql)).length, 0);
  });
});

describe("PATCH /keys/:id/policy 즉시 반영", () => {
  it("symbolic_hard_gate 변경은 30초 캐시를 기다리지 않고 바로 보인다", async () => {
    assert.equal(await getSymbolicHardGate(KEY_ID), false);
    assert.equal(await getSymbolicHardGate(KEY_ID), false);
    await patchPolicy({ symbolic_hard_gate: true });
    assert.equal(await getSymbolicHardGate(KEY_ID), true);
  });

  it("allowed_workspaces 변경은 30초 캐시를 기다리지 않고 바로 보인다", async () => {
    assert.equal(await getAllowedWorkspaces(KEY_ID), null);
    await patchPolicy({ allowed_workspaces: ["alpha"] });
    assert.deepEqual(await getAllowedWorkspaces(KEY_ID), ["alpha"]);
  });

  it("거부된 요청은 캐시를 비우지 않는다", async () => {
    assert.equal(await getSymbolicHardGate(KEY_ID), false);
    row.symbolic_hard_gate = true;
    const { res } = await patchPolicy({ symbolic_hard_gate: "yes" });
    assert.equal(res.statusCode, 400);
    assert.equal(await getSymbolicHardGate(KEY_ID), false, "캐시 항목이 유지되어야 한다");
  });
});

describe("PATCH /keys/:id/policy 감사 기록", () => {
  it("변경된 필드의 이름과 이전, 이후 값을 행위자와 함께 남긴다", async () => {
    await patchPolicy({ default_mode: "write-only", symbolic_hard_gate: true });
    assert.equal(audits.length, 1);
    const [{ operation, fields }] = audits;
    assert.equal(operation, "admin key_policy");
    assert.equal(fields.success, true);
    assert.match(fields.details, new RegExp(`target=${KEY_ID.slice(0, 8)}\\b`));
    assert.doesNotMatch(fields.details, new RegExp(KEY_ID));
    assert.doesNotMatch(fields.details, /\bkey=/);
    assert.match(fields.details, /default_mode null -> "write-only"/);
    assert.match(fields.details, /symbolic_hard_gate false -> true/);
    assert.doesNotMatch(fields.details, /allowed_workspaces/);
    assert.equal(fields.actor.keyId, "master");
  });

  it("값이 같은 필드는 기록하지 않고 변경 없음을 적는다", async () => {
    await patchPolicy({ symbolic_hard_gate: false });
    assert.match(audits[0].fields.details, /unchanged/);
  });

  it("거부된 요청은 정책 감사 줄을 만들지 않는다", async () => {
    await patchPolicy({ default_mode: "nope" });
    assert.equal(audits.length, 0);
  });
});

describe("PATCH /keys/:id/policy 거부", () => {
  const rejected = async (body, field) => {
    const { res } = await patchPolicy(body);
    assert.equal(res.statusCode, 400, JSON.stringify(body));
    assert.equal(res.body.field, field);
    assert.equal(updates().length, 0, "저장소에 닿으면 안 된다");
    assert.equal(audits.length, 0);
  };

  it("등록되지 않은 mode", () => rejected({ default_mode: "nope" }, "default_mode"));
  it("마스터 전용 mode(audit)", () => rejected({ default_mode: "audit" }, "default_mode"));
  it("allowed_workspaces가 배열이 아님", () => rejected({ allowed_workspaces: "alpha" }, "allowed_workspaces"));
  it("allowed_workspaces 항목 수 초과", () => rejected(
    { allowed_workspaces: Array.from({ length: 65 }, (_, i) => `ws-${i}`) }, "allowed_workspaces"));
  it("allowed_workspaces 항목 길이 초과", () => rejected({ allowed_workspaces: ["w".repeat(129)] }, "allowed_workspaces"));
  it("symbolic_hard_gate가 boolean이 아님", () => rejected({ symbolic_hard_gate: "true" }, "symbolic_hard_gate"));
  it("알 수 없는 필드", () => rejected({ daily_limit: 5 }, "daily_limit"));
  it("빈 객체", () => rejected({}, "body"));

  it("JSON이 아닌 본문은 400", async () => {
    const { res } = await patchPolicy("{not json");
    assert.equal(res.statusCode, 400);
    assert.equal(updates().length, 0);
  });
});

describe("PATCH /keys/:id/policy 저장소 결과", () => {
  it("없는 키는 404이고 캐시와 감사에 흔적이 없다", async () => {
    row = null;
    const { res } = await patchPolicy({ symbolic_hard_gate: true });
    assert.equal(res.statusCode, 404);
    assert.equal(audits.length, 0);
  });

  it("UUID 형식이 아닌 id는 404", async () => {
    poolFailure = Object.assign(new Error("invalid input syntax for type uuid"), { code: "22P02" });
    const { res } = await patchPolicy({ symbolic_hard_gate: true }, "nope");
    assert.equal(res.statusCode, 404);
  });

  it("저장소 오류는 500이고 내부 정보를 싣지 않으며 감사 줄을 만들지 않는다", async () => {
    poolFailure = new Error("connection refused db-internal:5432");
    const { res } = await patchPolicy({ symbolic_hard_gate: true });
    assert.equal(res.statusCode, 500);
    assert.doesNotMatch(JSON.stringify(res.body), /db-internal/);
    assert.equal(audits.length, 0);
  });
});

describe("PATCH /keys/:id/policy egress_policy", () => {
  it("정책을 저장하고 변경 후 값을 돌려준다", async () => {
    row.egress_policy = null;
    const { res } = await patchPolicy({ egress_policy: { local_only: true, workspaces: { open: { local_only: false } } } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.egress_policy, { local_only: true, workspaces: { open: { local_only: false } } });
    assert.deepEqual(row.egress_policy, { local_only: true, workspaces: { open: { local_only: false } } });
  });

  it("다른 열만 바꾸는 요청은 egress_policy 열을 읽지도 쓰지도 않는다", async () => {
    const { res } = await patchPolicy({ symbolic_hard_gate: true });
    assert.equal(res.statusCode, 200);
    assert.doesNotMatch(updates()[0].sql, /egress_policy/);
    assert.equal(Object.hasOwn(res.body, "egress_policy"), false);
  });

  it("변경은 30초 캐시를 기다리지 않고 바로 보인다", async () => {
    row.egress_policy = null;
    assert.equal(await getEgressPolicy(KEY_ID), null);
    await patchPolicy({ egress_policy: { local_only: true } });
    assert.deepEqual(await getEgressPolicy(KEY_ID), { local_only: true });
  });

  it("감사 기록에 이전과 이후 정책을 남긴다", async () => {
    row.egress_policy = null;
    await patchPolicy({ egress_policy: { local_only: true } });
    assert.match(audits[0].fields.details, /egress_policy null -> \{"local_only":true\}/);
  });

  it("같은 정책을 다시 쓰면 변경 없음으로 적는다", async () => {
    row.egress_policy = { approved_providers: ["codex-cli"], local_only: false };
    await patchPolicy({ egress_policy: { local_only: false, approved_providers: ["codex-cli"] } });
    assert.match(audits[0].fields.details, /unchanged/);
  });

  it("규칙에 맞지 않는 정책은 400이고 저장소에 닿지 않는다", async () => {
    const { res } = await patchPolicy({ egress_policy: { approved_providers: ["no-such-provider"] } });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.field, "egress_policy");
    assert.equal(updates().length, 0);
  });

  it("열이 없는 설치(migration-055 이전)에서는 409로 마이그레이션을 안내한다", async () => {
    poolFailure = Object.assign(new Error('column "egress_policy" does not exist'), { code: "42703" });
    const { res } = await patchPolicy({ egress_policy: { local_only: true } });
    assert.equal(res.statusCode, 409);
    assert.match(res.body.error, /migration-055/);
    assert.equal(audits.length, 0);
  });
});

describe("PATCH /keys/:id/policy egress.policy 능력", () => {
  const limited = { kind: "admin_session", id: "u-1", bindings: [{ role: "admin", workspace: null }], deny: ["egress.policy"] };

  it("egress.policy 능력이 없는 주체의 egress_policy 변경은 403이고 아무 열도 바꾸지 않는다", async () => {
    const { res } = await call("PATCH", `/keys/${KEY_ID}/policy`, { egress_policy: { local_only: true }, default_mode: "recall-only" }, limited);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.cap, "egress.policy");
    assert.equal(updates().length, 0);
  });

  it("같은 주체도 egress_policy가 없는 정책 변경은 key.policy로 처리한다", async () => {
    const { res } = await call("PATCH", `/keys/${KEY_ID}/policy`, { default_mode: "recall-only" }, limited);
    assert.equal(res.statusCode, 200);
    assert.equal(updates().length, 1);
  });
});

describe("라우팅", () => {
  it("GET과 PUT은 /policy를 처리하지 않는다", async () => {
    assert.equal((await call("GET", `/keys/${KEY_ID}/policy`)).handled, false);
    assert.equal((await call("PUT", `/keys/${KEY_ID}/policy`, {})).handled, false);
  });
});

describe("POST /keys 권한 검증", () => {
  const create = (body) => call("POST", "/keys", body);
  const inserts = () => sqls.filter((s) => /INSERT INTO .*api_keys/.test(s.sql));

  it("read와 write 이외의 값은 400이고 키를 만들지 않는다", async () => {
    const { res } = await create({ name: "k", permissions: ["admin"] });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.field, "permissions");
    assert.equal(inserts().length, 0);
  });

  it("배열이 아니거나 빈 배열이면 400", async () => {
    assert.equal((await create({ name: "k", permissions: "read" })).res.statusCode, 400);
    assert.equal((await create({ name: "k", permissions: [] })).res.statusCode, 400);
    assert.equal((await create({ name: "k", permissions: null })).res.statusCode, 400);
    assert.equal(inserts().length, 0);
  });

  it("유효한 권한은 그대로 저장한다", async () => {
    const { res } = await create({ name: "k", permissions: ["read"] });
    assert.equal(res.statusCode, 201);
    assert.deepEqual(inserts()[0].params[3], ["read"]);
  });

  it("권한을 생략하면 기본 권한으로 만든다", async () => {
    const { res } = await create({ name: "k" });
    assert.equal(res.statusCode, 201);
    assert.ok(Array.isArray(inserts()[0].params[3]) && inserts()[0].params[3].length > 0);
  });

  it("fragment_limit를 저장 계층에 그대로 전달한다", async () => {
    const { res } = await create({ name: "limited", fragment_limit: 5000 });
    assert.equal(res.statusCode, 201);
    assert.equal(inserts()[0].params[5], 5000);
    assert.equal(res.body.fragment_limit, 5000);
  });

  it("fragment_limit의 잘못된 숫자를 거부한다", async () => {
    for (const value of [0, -1, 1.5, "5000"]) {
      const { res } = await create({ name: "invalid-limit", fragment_limit: value });
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.field, "fragment_limit");
    }
    assert.equal(inserts().length, 0);
  });

  it("fragment_limit null은 관리자 무제한 키로 전달한다", async () => {
    const { res } = await create({ name: "unlimited", fragment_limit: null });
    assert.equal(res.statusCode, 201);
    assert.equal(inserts()[0].params[5], null);
  });
});
