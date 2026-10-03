/**
 * /audit 관리 API 시험(가짜 저장소)
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 목록 조건 판독과 오류 응답, JSONL 내보내기의 줄 형태와 형식 거부, 검증 본문 판독과 결과 전달,
 * 감사 표가 없을 때의 503, 라우트 판정을 본다.
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";
import { Readable }     from "node:stream";

process.env.DOTENV_CONFIG_PATH      ??= ".env.test";
process.env.MEMENTO_METRICS_DEFAULT ??= "off";

const { handleAudit } = await import("../../lib/admin/admin-audit.js");
const { ADMIN_BASE }  = await import("../../lib/admin/admin-auth.js");

function fakeRes() {
  const res = {
    statusCode: 200,
    headers   : {},
    body      : "",
    destroyed : false,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    removeHeader(name) { delete this.headers[name.toLowerCase()]; },
    write(chunk) { this.body += chunk; return true; },
    end(chunk = "") { this.body += chunk; this.ended = true; },
    destroy(err) { this.destroyed = true; this.destroyError = err; }
  };
  return res;
}

async function call(method, pathAndQuery, { body, store }) {
  const req   = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === "string" ? body : JSON.stringify(body))]);
  req.method  = method;
  req.headers = {};
  const res   = fakeRes();
  const handled = await handleAudit(req, res, new URL(`http://localhost${ADMIN_BASE}${pathAndQuery}`), { store });
  return { res, handled, json: () => JSON.parse(res.body) };
}

const EVENT = (seq) => ({ seq, action: "admin.key.create", outcome: "success", prevHash: "0".repeat(64), rowHash: "1".repeat(64) });

describe("GET /audit", () => {
  it("판독한 조건으로 목록을 돌려준다", async () => {
    let seen = null;
    const store = { list: async (filters) => { seen = filters; return { events: [EVENT(3)], nextBefore: null }; } };
    const { res, handled, json } = await call("GET", "/audit?action=admin.*&actor=master&limit=10", { store });
    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(json(), { events: [EVENT(3)], nextBefore: null });
    assert.equal(seen.actionPrefix, "admin.");
    assert.equal(seen.actorKind, "master");
    assert.equal(seen.limit, 10);
  });

  it("조건 형식이 틀리면 400과 필드 이름이다", async () => {
    const store = { list: async () => assert.fail("조회하면 안 된다") };
    const { res, json } = await call("GET", "/audit?outcome=maybe", { store });
    assert.equal(res.statusCode, 400);
    assert.equal(json().field, "outcome");
  });

  it("감사 표가 없으면 503이다", async () => {
    const store = { list: async () => { const e = new Error("relation does not exist"); e.code = "42P01"; throw e; } };
    const { res } = await call("GET", "/audit", { store });
    assert.equal(res.statusCode, 503);
  });

  it("그 밖의 오류는 내부 정보 없이 500이다", async () => {
    const store = { list: async () => { throw new Error("connection to db-host refused"); } };
    const { res } = await call("GET", "/audit", { store });
    assert.equal(res.statusCode, 500);
  });
});

describe("GET /audit/export", () => {
  it("행마다 해시를 담은 JSONL을 내려 준다", async () => {
    const store = { scan: async function* () { yield EVENT(1); yield EVENT(2); } };
    const { res } = await call("GET", "/audit/export?format=jsonl&action=admin.key.create", { store });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers["content-type"], /application\/x-ndjson/);
    assert.match(res.headers["content-disposition"], /audit-events\.jsonl/);
    const lines = res.body.trim().split("\n").map(l => JSON.parse(l));
    assert.deepEqual(lines.map(l => l.seq), [1, 2]);
    assert.ok(lines.every(l => l.prevHash && l.rowHash));
  });

  it("jsonl이 아닌 형식은 400이다", async () => {
    const store = { scan: () => assert.fail("읽으면 안 된다") };
    const { res, json } = await call("GET", "/audit/export?format=csv", { store });
    assert.equal(res.statusCode, 400);
    assert.equal(json().field, "format");
  });

  it("줄을 보낸 뒤 실패하면 연결을 끊는다", async () => {
    const store = { scan: async function* () { yield EVENT(1); throw new Error("read failed"); } };
    const { res } = await call("GET", "/audit/export", { store });
    assert.equal(res.destroyed, true);
  });
});

describe("POST /audit/verify", () => {
  it("본문의 fromSeq와 maxRows를 넘기고 결과를 그대로 돌려준다", async () => {
    let args = null;
    const result = { ok: false, checked: 4, broken: { seq: 5, reason: "row_hash_mismatch" } };
    const store  = { verify: async (a) => { args = a; return result; } };
    const { res, json } = await call("POST", "/audit/verify", { body: { fromSeq: 2, maxRows: 100 }, store });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(args, { fromSeq: 2, maxRows: 100 });
    assert.deepEqual(json(), result);
  });

  it("본문이 없으면 처음부터 검증한다", async () => {
    let args = null;
    const store = { verify: async (a) => { args = a; return { ok: true }; } };
    await call("POST", "/audit/verify", { store });
    assert.deepEqual(args, { fromSeq: null });
  });

  it("정수가 아닌 값과 깨진 JSON은 400이다", async () => {
    const store = { verify: async () => assert.fail("검증하면 안 된다") };
    assert.equal((await call("POST", "/audit/verify", { body: { maxRows: "many" }, store })).res.statusCode, 400);
    assert.equal((await call("POST", "/audit/verify", { body: "{", store })).res.statusCode, 400);
  });
});

describe("라우트 판정", () => {
  it("/audit 밖과 맞지 않는 메서드는 처리하지 않는다", async () => {
    const store = {};
    assert.equal((await call("GET", "/keys", { store })).handled, false);
    assert.equal((await call("DELETE", "/audit", { store })).handled, false);
    assert.equal((await call("GET", "/audit/verify", { store })).handled, false);
  });
});
