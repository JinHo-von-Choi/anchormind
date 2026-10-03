/**
 * 키 수명 관리 라우트 동작 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * DB 풀과 세션 닫기만 대체하고 실제 라우트 표, 검증기, 수명 저장소 함수를 거친다.
 *   PATCH /keys/:id, POST /keys/:id/rotate, POST /keys/:id/revoke, POST /keys/:id/access-review, POST /keys 수명 열
 * 감사 detail은 처리기 메모(takeAdminAuditNote)로 확인한다. 원시 키와 본문 비밀은 detail에 없어야 한다.
 */
import { describe, it, mock, beforeEach } from "node:test";
import assert                              from "node:assert/strict";
import { Readable }                        from "node:stream";

/** 허용 대역 쓰기는 신뢰 프록시 hop 수가 설정된 서버에서만 받는다(설정 없는 경우는 admin-key-cidr-hops.test.js). */
process.env.TRUST_PROXY_HOPS = "1";

const KEY_ID = "7a1e0000-0000-4000-8000-0000000000f5";

let key;
let sqls;
let closed;
let closeFailure;

/** 키 한 행과 비밀 행 목록을 흉내 내는 질의 처리 */
async function handle(sql, params = []) {
  const text = sql.trim();
  sqls.push({ sql: text, params });
  if (/^(BEGIN|COMMIT|ROLLBACK)/.test(text)) return { rows: [], rowCount: 0 };
  if (/FOR UPDATE$/.test(text) && /^SELECT id, name, key_hash/.test(text)) {
    return { rows: key ? [{ id: key.id, name: key.name, key_hash: key.key_hash, key_prefix: key.key_prefix, created_at: key.created_at, revoked_at: key.revoked_at }] : [] };
  }
  if (/^INSERT INTO agent_memory\.api_key_secrets/.test(text)) {
    if (!key.secrets.some((s) => s.key_hash === params[0])) key.secrets.push({ key_hash: params[0], status: "active", valid_until: null });
    return { rows: [], rowCount: 1 };
  }
  if (/^UPDATE agent_memory\.api_key_secrets\s+SET\s+valid_until/.test(text)) {
    const active = key.secrets.filter((s) => s.status === "active");
    for (const s of active) if (s.valid_until === null || s.valid_until > params[1]) s.valid_until = params[1];
    return { rows: [], rowCount: active.length };
  }
  if (/^UPDATE agent_memory\.api_keys SET key_hash/.test(text)) {
    key.key_hash = params[1]; key.key_prefix = params[2];
    return { rows: [], rowCount: 1 };
  }
  if (/^UPDATE agent_memory\.api_keys\s+SET\s+revoked_at/.test(text)) {
    Object.assign(key, { revoked_at: new Date(), revoked_by: params[1], revoke_reason: params[2], status: "inactive" });
    return { rows: [{ id: key.id, name: key.name, status: key.status, revoked_at: key.revoked_at, revoked_by: key.revoked_by, revoke_reason: key.revoke_reason }], rowCount: 1 };
  }
  if (/^UPDATE agent_memory\.api_key_secrets SET status/.test(text)) {
    const changed = key.secrets.filter((s) => s.status !== "revoked");
    for (const s of changed) s.status = "revoked";
    return { rows: [], rowCount: changed.length };
  }
  if (/^WITH prev AS \(\s+SELECT id, expires_at/.test(text)) {
    if (!key) return { rows: [], rowCount: 0 };
    const row = {};
    for (const f of ["expires_at", "description", "owner", "kind", "allowed_cidrs"]) row[`prev_${f}`] = key[f];
    for (const [, col, idx] of text.matchAll(/(\w+) = \$(\d+)/g)) if (col in row || `prev_${col}` in row) key[col] = params[Number(idx) - 1];
    for (const f of ["expires_at", "description", "owner", "kind", "allowed_cidrs"]) row[f] = key[f];
    return { rows: [row], rowCount: 1 };
  }
  if (/^WITH prev AS \(\s+SELECT id, access_reviewed_at/.test(text)) {
    if (!key) return { rows: [], rowCount: 0 };
    const previous = key.access_reviewed_at;
    Object.assign(key, { access_reviewed_at: new Date(), access_reviewed_by: params[1] });
    return { rows: [{ access_reviewed_at: key.access_reviewed_at, access_reviewed_by: key.access_reviewed_by, previous_reviewed_at: previous }], rowCount: 1 };
  }
  if (/WITH k AS \(\s+INSERT INTO agent_memory\.api_keys/.test(text)) {
    return { rows: [{ id: KEY_ID, name: params[0], permissions: params[3], daily_limit: params[4], expires_at: params[6], allowed_cidrs: params[10] }], rowCount: 1 };
  }
  if (/^UPDATE agent_memory\.api_keys\s+SET\s+status = \$2/.test(text)) {
    if (/revoked_at IS NULL/.test(text) && key.revoked_at && params[1] === "active") return { rows: [], rowCount: 0 };
    key.status = params[1];
    return { rows: [{ id: key.id, name: key.name, status: key.status }], rowCount: 1 };
  }
  if (/^SELECT revoked_at FROM/.test(text)) return { rows: key ? [{ revoked_at: key.revoked_at }] : [] };
  return { rows: [], rowCount: 0 };
}

const pool = {
  query  : handle,
  connect: async () => ({ query: handle, release: () => {} })
};

mock.module("../../lib/tools/db.js", { exports: { getPrimaryPool: () => pool } });
mock.module("../../lib/sessions.js", {
  exports: {
    closeSessionsByKeyId: async (id) => {
      if (closeFailure) throw closeFailure;
      closed.push(id);
      return 2;
    }
  }
});

const { handleKeys }        = await import("../../lib/admin/admin-keys.js");
const { takeAdminAuditNote, adminAuditEvent } = await import("../../lib/admin/admin-audit-actions.js");
const { buildAuditPayload }  = await import("../../lib/logging/audit-event.js");
const { ADMIN_BASE }        = await import("../../lib/admin/admin-auth.js");

function request(method, path, body) {
  const req   = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === "string" ? body : JSON.stringify(body))]);
  req.method  = method;
  req.headers = { authorization: "Bearer master" };
  req.socket  = { remoteAddress: "127.0.0.1" };
  return { req, url: new URL(`http://localhost${ADMIN_BASE}${path}`) };
}

async function call(method, path, body) {
  const { req, url } = request(method, path, body);
  const res = { statusCode: 0, headers: {}, body: "", setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = b ?? ""; } };
  const handled = await handleKeys(req, res, url);
  return { handled, status: res.statusCode, data: res.body ? JSON.parse(res.body) : null, note: takeAdminAuditNote(res) };
}

beforeEach(() => {
  sqls   = [];
  closed       = [];
  closeFailure = null;
  key    = {
    id: KEY_ID, name: "svc", key_hash: "a".repeat(64), key_prefix: "mmcp_svc_aaaaa", created_at: new Date("2026-01-01T00:00:00Z"),
    status: "active", revoked_at: null, expires_at: null, description: null, owner: null, kind: null, allowed_cidrs: null,
    access_reviewed_at: null, secrets: []
  };
});

describe("POST /keys/:id/rotate", () => {
  it("새 원시 키를 한 번 돌려주고 이전 해시를 겹침 동안 남긴다", async () => {
    const before = Date.now();
    const r = await call("POST", `/keys/${KEY_ID}/rotate`, { graceHours: 2 });
    assert.equal(r.status, 200);
    assert.match(r.data.raw_key, /^mmcp_svc_[0-9a-f]{32}$/);
    assert.equal(r.data.key_prefix, r.data.raw_key.slice(0, 14));
    assert.equal(key.secrets.length, 2, "이전 해시와 새 해시");
    const old = key.secrets.find((s) => s.key_hash === "a".repeat(64));
    assert.ok(old.valid_until.getTime() >= before + 2 * 3_600_000 - 5);
    assert.notEqual(key.key_hash, "a".repeat(64), "api_keys.key_hash는 새 해시다");
    assert.equal(sqls[0].sql, "BEGIN");
    assert.equal(sqls.at(-1).sql, "COMMIT");
    assert.equal(r.note.detail.graceHours, 2);
    assert.ok(!JSON.stringify(r.note).includes(r.data.raw_key), "감사 detail에 원시 키가 없다");
    assert.ok(!sqls.some((q) => q.params.includes(r.data.raw_key)), "질의 값에 원시 키가 없다");
  });

  it("겹침 회전은 세션을 닫지 않고, 겹침 0은 그 키의 세션을 바로 닫는다", async () => {
    const overlap = await call("POST", `/keys/${KEY_ID}/rotate`, { graceHours: 1 });
    assert.deepEqual(closed, []);
    assert.equal(overlap.data.closed_sessions, 0);
    const immediate = await call("POST", `/keys/${KEY_ID}/rotate`, { graceHours: 0 });
    assert.equal(immediate.status, 200);
    assert.deepEqual(closed, [KEY_ID]);
    assert.equal(immediate.data.closed_sessions, 2);
    assert.equal(immediate.note.detail.closedSessions, 2);
    assert.ok(key.secrets.filter((s) => s.key_hash !== key.key_hash).every((s) => s.valid_until.getTime() <= Date.now()));
  });

  it("본문이 없으면 기본 겹침 24시간이다", async () => {
    const r = await call("POST", `/keys/${KEY_ID}/rotate`);
    assert.equal(r.status, 200);
    assert.equal(r.note.detail.graceHours, 24);
  });

  it("잘못된 겹침 시간은 400, 폐기한 키는 409, 없는 키는 404다", async () => {
    assert.equal((await call("POST", `/keys/${KEY_ID}/rotate`, { graceHours: -1 })).status, 400);
    key.revoked_at = new Date();
    const conflict = await call("POST", `/keys/${KEY_ID}/rotate`, {});
    assert.equal(conflict.status, 409);
    assert.equal(conflict.data.error, "key_revoked");
    assert.equal(sqls.at(-1).sql, "ROLLBACK");
    key = null;
    assert.equal((await call("POST", `/keys/${KEY_ID}/rotate`, {})).status, 404);
  });
});

describe("POST /keys/:id/revoke", () => {
  it("사유를 남기고 비밀 행을 폐기하며 세션을 닫는다", async () => {
    key.secrets.push({ key_hash: "a".repeat(64), status: "active", valid_until: null });
    const r = await call("POST", `/keys/${KEY_ID}/revoke`, { reason: "leaked in ci log" });
    assert.equal(r.status, 200);
    assert.equal(key.status, "inactive");
    assert.equal(key.revoke_reason, "leaked in ci log");
    assert.equal(key.revoked_by, "master:bearer");
    assert.equal(key.secrets[0].status, "revoked");
    assert.deepEqual(closed, [KEY_ID]);
    assert.deepEqual(r.note.detail, { reason: "leaked in ci log", revokedHashes: 1, closedSessions: 2, sessionCloseFailed: false });
    assert.equal(r.data.warning, undefined);
  });

  it("세션 닫기가 실패해도 커밋한 폐기는 성공으로 응답하고 경고와 감사 detail을 남긴다", async () => {
    closeFailure = new Error("redis down");
    const r = await call("POST", `/keys/${KEY_ID}/revoke`, { reason: "leak" });
    assert.equal(r.status, 200);
    assert.equal(r.data.warning, "session_close_failed");
    assert.equal(key.status, "inactive");
    assert.deepEqual(r.note.detail, { reason: "leak", revokedHashes: 0, closedSessions: null, sessionCloseFailed: true });
  });

  it("사유가 없으면 400, 이미 폐기한 키는 409다", async () => {
    const missing = await call("POST", `/keys/${KEY_ID}/revoke`, {});
    assert.equal(missing.status, 400);
    assert.equal(missing.data.field, "reason");
    key.revoked_at = new Date();
    const again = await call("POST", `/keys/${KEY_ID}/revoke`, { reason: "x" });
    assert.equal(again.status, 409);
    assert.equal(again.data.error, "already_revoked");
  });

  it("폐기한 키는 상태 변경으로 다시 활성화하지 않는다", async () => {
    key.revoked_at = new Date();
    key.status     = "inactive";
    const r = await call("PUT", `/keys/${KEY_ID}`, { status: "active" });
    assert.equal(r.status, 409);
    assert.equal(r.data.error, "key_revoked");
    assert.equal(key.status, "inactive");
  });
});

describe("PATCH /keys/:id", () => {
  it("만료와 허용 대역을 바꾸고 바뀐 필드를 감사 detail에 남긴다", async () => {
    const r = await call("PATCH", `/keys/${KEY_ID}`, { expires_at: "2027-01-01T00:00:00Z", allowed_cidrs: ["198.51.100.0/24"], description: "ci runner" });
    assert.equal(r.status, 200);
    assert.equal(key.expires_at, "2027-01-01T00:00:00.000Z");
    assert.deepEqual(key.allowed_cidrs, ["198.51.100.0/24"]);
    assert.deepEqual(r.note.detail.changed, ["expires_at", "description", "allowed_cidrs"]);
    assert.deepEqual(r.note.detail.after, { expires_at: "2027-01-01T00:00:00.000Z", allowed_cidrs: ["198.51.100.0/24"] });
  });

  it("오프셋 없는 만료 시각과 날짜 아닌 값은 400이다", async () => {
    for (const bad of ["2027-01-01T00:00:00", "1", "March 7, 2027"]) {
      const r = await call("PATCH", `/keys/${KEY_ID}`, { expires_at: bad });
      assert.equal(r.status, 400, bad);
      assert.equal(r.data.field, "expires_at");
    }
  });

  it("잘못된 값은 필드와 함께 400이다", async () => {
    const r = await call("PATCH", `/keys/${KEY_ID}`, { allowed_cidrs: ["198.51.100.0/40"] });
    assert.equal(r.status, 400);
    assert.equal(r.data.field, "allowed_cidrs");
    assert.equal((await call("PATCH", `/keys/${KEY_ID}`, "{nope")).status, 400);
  });

  it("없는 키는 404다", async () => {
    key = null;
    assert.equal((await call("PATCH", `/keys/${KEY_ID}`, { owner: "a" })).status, 404);
  });
});

describe("POST /keys/:id/access-review", () => {
  it("검토 시각과 행위자를 남긴다", async () => {
    const r = await call("POST", `/keys/${KEY_ID}/access-review`);
    assert.equal(r.status, 200);
    assert.equal(r.data.access_reviewed_by, "master:bearer");
    assert.equal(r.note.detail.reviewedBy, "master:bearer");
    assert.equal(r.note.detail.previousReviewedAt, null);
  });
});

describe("POST /keys 수명 열", () => {
  it("수명 열을 검증해 생성에 넘기고 감사 detail에 남긴다", async () => {
    const r = await call("POST", "/keys", { name: "svc2", expires_at: "2027-01-01T00:00:00Z", allowed_cidrs: ["192.0.2.0/24"] });
    assert.equal(r.status, 201);
    assert.match(r.data.raw_key, /^mmcp_svc2_/);
    assert.equal(r.note.detail.after.expires_at, "2027-01-01T00:00:00.000Z");
    assert.deepEqual(r.note.detail.after.allowed_cidrs, ["192.0.2.0/24"]);
  });

  it("잘못된 수명 열은 400이다", async () => {
    const r = await call("POST", "/keys", { name: "svc3", kind: "Bad Kind" });
    assert.equal(r.status, 400);
    assert.equal(r.data.field, "kind");
  });
});

describe("감사 이벤트 규칙", () => {
  it("수명 라우트의 처리기 메모는 감사 payload 규칙을 통과하고 원시 키를 담지 않는다", async () => {
    const cases = [
      ["POST", `/keys/${KEY_ID}/rotate`, { graceHours: 0 }, "admin.key.rotate"],
      ["PATCH", `/keys/${KEY_ID}`, { expires_at: "2027-01-01T00:00:00Z", owner: "팀 운영", allowed_cidrs: ["198.51.100.0/24"] }, "admin.key.lifecycle_update"],
      ["POST", `/keys/${KEY_ID}/access-review`, undefined, "admin.key.access_review"],
      ["POST", `/keys/${KEY_ID}/revoke`, { reason: "유출 의심" }, "admin.key.revoke"],
      ["POST", "/keys", { name: "svc4", expires_at: "2027-01-01T00:00:00Z" }, "admin.key.create"]
    ];
    for (const [method, path, body, action] of cases) {
      const r       = await call(method, path, body);
      const event   = adminAuditEvent({ method, subPath: path, maskedPath: path, status: r.status, outcome: "success",
        actor: { keyId: "master", sessionId: "bearer", clientIp: "192.0.2.1" }, note: r.note });
      const payload = buildAuditPayload(event);
      assert.equal(payload.action, action);
      if (r.data?.raw_key) assert.ok(!JSON.stringify(payload).includes(r.data.raw_key));
    }
  });
});
