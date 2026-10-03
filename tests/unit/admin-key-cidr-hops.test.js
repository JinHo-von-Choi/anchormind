/**
 * TRUST_PROXY_HOPS 미설정 서버의 허용 대역 쓰기 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-04
 *
 * hop 수가 설정되지 않으면 요청 주소가 X-Forwarded-For 첫 항목이므로 허용 대역 목록 쓰기(PATCH /keys/:id,
 * POST /keys)를 409 trust_proxy_hops_unset으로 거부한다. 목록 해제(null)와 다른 수명 열 변경은 받는다.
 */
import { describe, it, mock } from "node:test";
import assert                 from "node:assert/strict";
import { Readable }           from "node:stream";

delete process.env.TRUST_PROXY_HOPS;

const KEY_ID  = "7a1e0000-0000-4000-8000-0000000000f6";
const updates = [];

const pool = {
  query: async (sql, params = []) => {
    if (/^WITH prev AS/.test(sql.trim())) {
      updates.push(params);
      return { rows: [{ owner: params[1] ?? null }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }
};
mock.module("../../lib/tools/db.js", { exports: { getPrimaryPool: () => pool } });
mock.module("../../lib/sessions.js", { exports: { closeSessionsByKeyId: async () => 0 } });

const { handleKeys } = await import("../../lib/admin/admin-keys.js");
const { ADMIN_BASE } = await import("../../lib/admin/admin-auth.js");

async function call(method, path, body) {
  const req   = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.method  = method;
  req.headers = {};
  const res   = { statusCode: 0, body: "", setHeader() {}, end(b) { this.body = b ?? ""; } };
  await handleKeys(req, res, new URL(`http://localhost${ADMIN_BASE}${path}`));
  return { status: res.statusCode, data: res.body ? JSON.parse(res.body) : null };
}

describe("hop 수 미설정 서버의 허용 대역", () => {
  it("목록 쓰기는 409이고 갱신하지 않는다", async () => {
    const patch = await call("PATCH", `/keys/${KEY_ID}`, { allowed_cidrs: ["192.0.2.0/24"] });
    assert.equal(patch.status, 409);
    assert.equal(patch.data.error, "trust_proxy_hops_unset");
    assert.match(patch.data.message, /TRUST_PROXY_HOPS/);
    const create = await call("POST", "/keys", { name: "svc", allowed_cidrs: [] });
    assert.equal(create.status, 409);
    assert.equal(updates.length, 0);
  });

  it("목록 해제와 다른 수명 열은 받는다", async () => {
    assert.equal((await call("PATCH", `/keys/${KEY_ID}`, { allowed_cidrs: null })).status, 200);
    assert.equal((await call("PATCH", `/keys/${KEY_ID}`, { owner: "team" })).status, 200);
  });
});
