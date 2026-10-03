/**
 * 관리 처리기의 감사 메모 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * DB 풀만 대체하고 실제 admin-keys 라우트 표와 처리기를 거쳐, 상태를 바꾼 처리기가 감사 이벤트에 덧붙이는
 * 대상 id와 변경 값(정책은 이전과 이후)을 본다. 생성한 키의 원문 키는 메모에 들어가지 않는다.
 */

import { describe, it, mock, beforeEach } from "node:test";
import assert                              from "node:assert/strict";
import { Readable }                        from "node:stream";

process.env.DOTENV_CONFIG_PATH      ??= ".env.test";
process.env.MEMENTO_METRICS_DEFAULT ??= "off";
process.env.REDIS_ENABLED           ??= "false";
process.env.CACHE_ENABLED           ??= "false";

const KEY_ID   = "7a1e0000-0000-4000-8000-0000000000a1";
const GROUP_ID = "7a1e0000-0000-4000-8000-0000000000b2";
let   policyRow;

const pool = {
  query: async (sql, params = []) => {
    const text = sql.trim();
    if (/^WITH prev AS/.test(text)) {
      const prev = { ...policyRow };
      for (const [, col, idx] of [...text.matchAll(/(\w+) = \$(\d+)/g)].filter(([, c]) => c in policyRow)) policyRow[col] = params[Number(idx) - 1];
      return {
        rowCount: 1,
        rows    : [{
          prev_default_mode: prev.default_mode, prev_allowed_workspaces: prev.allowed_workspaces, prev_symbolic_hard_gate: prev.symbolic_hard_gate,
          default_mode: policyRow.default_mode, allowed_workspaces: policyRow.allowed_workspaces, symbolic_hard_gate: policyRow.symbolic_hard_gate
        }]
      };
    }
    if (/INSERT INTO .*api_keys/.test(text)) {
      return { rows: [{ id: KEY_ID, name: params[0], key_prefix: "mmcp_x", permissions: params[3], status: "active", daily_limit: params[4] }] };
    }
    if (/INSERT INTO .*api_key_groups/.test(text)) return { rows: [{ id: GROUP_ID, name: params[0] }] };
    if (/UPDATE .*api_keys/.test(text)) return { rowCount: 1, rows: [{ id: KEY_ID, status: "inactive", daily_limit: 77, permissions: ["read"] }] };
    return { rows: [], rowCount: 0 };
  }
};

mock.module("../../lib/tools/db.js", { exports: { getPrimaryPool: () => pool } });
mock.module("../../lib/sessions.js", { exports: { closeSessionsByKeyId: async () => 0 } });
const realAudit = await import("../../lib/logging/audit.js");
mock.module("../../lib/logging/audit.js", { exports: { ...realAudit, logAudit: async () => {} } });

const { handleKeys }         = await import("../../lib/admin/admin-keys.js");
const { takeAdminAuditNote } = await import("../../lib/admin/admin-audit-actions.js");
const { sanitizeAuditDetail } = await import("../../lib/logging/audit-event.js");
const ADMIN_BASE = "/v1/internal/model/nothing";

async function call(method, pathname, body) {
  const req   = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  req.method  = method;
  req.headers = {};
  const chunks = [];
  const res   = { statusCode: 0, setHeader() {}, end(b) { if (b) chunks.push(b); } };
  await handleKeys(req, res, new URL(`http://localhost${ADMIN_BASE}${pathname}`));
  return { res, note: takeAdminAuditNote(res), body: chunks.length ? JSON.parse(chunks.join("")) : null };
}

beforeEach(() => {
  policyRow = { default_mode: null, allowed_workspaces: null, symbolic_hard_gate: false };
});

describe("키 처리기의 감사 메모", () => {
  it("키 생성은 새 키 id를 대상으로, 권한과 일일 한도를 이후 값으로 남기고 원문 키는 남기지 않는다", async () => {
    const { res, note, body } = await call("POST", "/keys", { name: "audit-test", permissions: ["read"] });
    assert.equal(res.statusCode, 201);
    assert.equal(note.targetId, KEY_ID);
    assert.deepEqual(note.detail.after.permissions, ["read"]);
    assert.ok(typeof body.raw_key === "string" && body.raw_key.length > 0);
    assert.ok(!JSON.stringify(note).includes(body.raw_key));
  });

  it("정책 변경은 바뀐 필드와 이전, 이후 값을 남기고 감사 규칙을 통과한다", async () => {
    const { res, note } = await call("PATCH", `/keys/${KEY_ID}/policy`, { allowed_workspaces: ["team-a"], symbolic_hard_gate: true });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(note.detail, {
      changed: ["allowed_workspaces", "symbolic_hard_gate"],
      before : { allowed_workspaces: null, symbolic_hard_gate: false },
      after  : { allowed_workspaces: ["team-a"], symbolic_hard_gate: true }
    });
    assert.deepEqual(sanitizeAuditDetail(note.detail), note.detail);
  });

  it("거부된 요청은 메모를 남기지 않는다", async () => {
    const { res, note } = await call("PATCH", `/keys/${KEY_ID}/policy`, { default_mode: 42 });
    assert.equal(res.statusCode, 400);
    assert.deepEqual(note, { targetId: null, detail: {} });
  });

  it("그룹 생성은 새 그룹 id를, 구성원 추가는 구성원 키 id를 남긴다", async () => {
    assert.equal((await call("POST", "/groups", { name: "g" })).note.targetId, GROUP_ID);
    const added = await call("POST", `/groups/${GROUP_ID}/members`, { key_id: KEY_ID });
    assert.equal(added.note.detail.memberKeyId, KEY_ID);
  });
});
