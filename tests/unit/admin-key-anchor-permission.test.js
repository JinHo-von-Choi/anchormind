/**
 * anchor 권한 부여 경로와 앵커 조회, 감사 기록 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * DB 풀과 감사 기록기만 대체하고 실제 라우트 표, 검증기, 저장소 함수를 거친다. 콘솔 키 상세의
 * PERMISSIONS 토글이 서버가 받는 권한 값과 같은지도 본다.
 */
import { describe, it, mock, beforeEach } from "node:test";
import assert                              from "node:assert/strict";
import { Readable }                        from "node:stream";

process.env.DOTENV_CONFIG_PATH      ??= ".env.test";
process.env.MEMENTO_METRICS_DEFAULT ??= "off";
process.env.REDIS_ENABLED           ??= "false";
process.env.CACHE_ENABLED           ??= "false";

const KEY_ID = "5b0c0000-0000-4000-8000-0000000000a7";

let   row;
let   anchorCount;
let   sqls;
const audits = [];

const pool = {
  query: async (sql, params = []) => {
    const text = sql.trim();
    sqls.push({ sql: text, params });
    if (/^WITH prev AS/.test(text) && /permissions = \$1/.test(text)) {
      if (!row) return { rows: [], rowCount: 0 };
      const before = row.permissions;
      row.permissions = params[0];
      return { rowCount: 1, rows: [{ prev_permissions: before, permissions: row.permissions }] };
    }
    if (/^SELECT permissions FROM .*api_keys WHERE id = \$1/.test(text)) return { rows: row ? [{ permissions: row.permissions }] : [] };
    if (/COUNT\(\*\)::int AS count FROM .*fragments/.test(text))         return { rows: [{ count: anchorCount }] };
    return { rows: [], rowCount: 0 };
  }
};

mock.module("../../lib/tools/db.js", { exports: { getPrimaryPool: () => pool } });
mock.module("../../lib/sessions.js", { exports: { closeSessionsByKeyId: async () => 0 } });

const realAudit = await import("../../lib/logging/audit.js");
mock.module("../../lib/logging/audit.js", {
  exports: { ...realAudit, logAudit: async (operation, fields) => { audits.push({ operation, fields }); } }
});

const { handleKeys }          = await import("../../lib/admin/admin-keys.js");
const { getAnchorState }      = await import("../../lib/admin/ApiKeyStore.js");
const { auditAnchorDecision, formatAnchorAuditDetails } = await import("../../lib/memory/write/anchorAudit.js");
const {
  KEY_PERMISSION_VALUES,
  validatePermissionList,
  KeyPolicyValidationError,
  formatKeyPermissionAuditDetails
} = await import("../../lib/admin/key-policy.js");

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

async function putPermissions(body, id = KEY_ID) {
  const req   = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.method  = "PUT";
  req.headers = {};
  const res   = fakeRes();
  await handleKeys(req, res, new URL(`http://localhost${ADMIN_BASE}/keys/${id}/permissions`));
  return res;
}

const settle = () => new Promise(resolve => setImmediate(resolve));

beforeEach(() => {
  row           = { permissions: ["read", "write"] };
  anchorCount   = 0;
  sqls          = [];
  audits.length = 0;
});

describe("anchor 권한 값", () => {
  it("키 권한 값에 anchor가 있다", () => {
    assert.ok(KEY_PERMISSION_VALUES.includes("anchor"));
  });

  it("키 생성 권한 목록은 anchor를 받고 그 밖의 값은 거부한다", () => {
    assert.deepEqual(validatePermissionList(["read", "write", "anchor"]), ["read", "write", "anchor"]);
    assert.throws(() => validatePermissionList(["read", "owner"]), KeyPolicyValidationError);
  });

  it("권한 변경 감사 문자열은 대상 키 앞 8자와 변경 전후 값을 싣는다", () => {
    const details = formatKeyPermissionAuditDetails(KEY_ID, ["read", "write"], ["read", "write", "anchor"]);
    assert.match(details, new RegExp(`^target=${KEY_ID.slice(0, 8)} `));
    assert.ok(!details.includes(KEY_ID.slice(8)), "대상 키 전체를 싣지 않는다");
    assert.match(details, /\["read","write"\] -> \["read","write","anchor"\]/);
  });
});

describe("PUT /keys/:id/permissions", () => {
  it("anchor를 부여하고 변경 전후를 감사 기록에 남긴다", async () => {
    const res = await putPermissions({ permissions: ["read", "write", "anchor"] });
    await settle();
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { success: true, permissions: ["read", "write", "anchor"] });
    const entry = audits.find(a => a.operation === "admin key_permissions");
    assert.ok(entry, "권한 변경 감사 기록 없음");
    assert.equal(entry.fields.success, true);
    assert.match(entry.fields.details, /\["read","write"\] -> \["read","write","anchor"\]/);
  });

  it("허용하지 않는 권한 값은 400이고 바꾸지 않는다", async () => {
    const res = await putPermissions({ permissions: ["read", "root"] });
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /anchor/);
    assert.deepEqual(row.permissions, ["read", "write"]);
  });

  it("없는 키는 404다", async () => {
    row = null;
    const res = await putPermissions({ permissions: ["read"] });
    assert.equal(res.statusCode, 404);
  });
});

describe("getAnchorState", () => {
  it("권한 목록과 살아 있는 앵커 수를 돌려준다", async () => {
    row         = { permissions: ["write", "anchor"] };
    anchorCount = 7;
    assert.deepEqual(await getAnchorState(KEY_ID), { permissions: ["write", "anchor"], anchorCount: 7 });
    const count = sqls.find(s => /fragments/.test(s.sql));
    assert.match(count.sql, /is_anchor = TRUE/);
    assert.match(count.sql, /valid_to IS NULL/);
    assert.deepEqual(count.params, [KEY_ID]);
  });

  it("키 행이 없으면 null이고 앵커 수를 세지 않는다", async () => {
    row = null;
    assert.equal(await getAnchorState(KEY_ID), null);
    assert.equal(sqls.filter(s => /fragments/.test(s.sql)).length, 0);
  });
});

describe("auditAnchorDecision", () => {
  const event = {
    entry: "remember", op: "create", change: "set", outcome: "downgraded", reason: "permission",
    fragmentId: "frag-1", fragmentType: "fact", keyId: KEY_ID, isMaster: false
  };

  it("anchor 작업으로 판정, 파편, 행위자 키를 남긴다", async () => {
    await auditAnchorDecision(event);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].operation, "anchor");
    assert.equal(audits[0].fields.fragmentId, "frag-1");
    assert.equal(audits[0].fields.success, true);
    assert.equal(audits[0].fields.actor.keyId, KEY_ID);
    assert.equal(audits[0].fields.details, formatAnchorAuditDetails(event));
    for (const part of ["entry=remember", "change=set", "outcome=downgraded", "reason=permission"]) {
      assert.ok(audits[0].fields.details.includes(part), part);
    }
  });

  it("거부는 실패로, master 판정은 master 행위자로 남긴다", async () => {
    await auditAnchorDecision({ ...event, outcome: "rejected" });
    await auditAnchorDecision({ ...event, keyId: null, isMaster: true, outcome: "granted", reason: "master" });
    assert.equal(audits[0].fields.success, false);
    assert.equal(audits[1].fields.actor.keyId, "master");
  });
});
