/**
 * Legacy SSE 메시지의 키 상태 재확인 시험(저장소 대체)
 *
 * 작성자: 최진호
 * 작성일: 2026-10-04
 *
 * DB 풀만 대체하고 실제 키 저장소와 재확인 캐시를 거친다. 키 세션의 POST /message는 회전 퇴역 시각이 지났고
 * 세션이 그보다 먼저 만들어졌으면 세션을 닫고 404로 응답한다. 퇴역 시각 뒤에 만든 세션과 퇴역 시각이 없는 키는 그대로 처리한다.
 */
import { describe, it, mock, beforeEach } from "node:test";
import assert                              from "node:assert/strict";
import { Readable }                        from "node:stream";

let keyState;

const realDb = await import("../../lib/tools/db.js");
mock.module("../../lib/tools/db.js", {
  exports: {
    ...realDb,
    getPrimaryPool: () => ({
      query: async (sql) => {
        if (/FROM agent_memory\.api_keys k WHERE k\.id = \$1/.test(sql)) {
          return { rows: [{ status: keyState.status, permissions: ["read"], revoked_at: keyState.revokedAt ?? null, expires_at: null, allowed_cidrs: null, secret_retirements: keyState.secretRetirements }] };
        }
        return { rows: [] };
      }
    })
  }
});
mock.module("../../lib/memory/processors/AutoReflect.js", { exports: { autoReflect: async () => null } });

const { handleLegacySsePost }                         = await import("../../lib/handlers/sse-handler.js");
const { createLegacySseSession, getLegacySession }    = await import("../../lib/sessions.js");
const { invalidateKeyState }                          = await import("../../lib/admin/key-state-cache.js");

const KEY_ID = "550e8400-e29b-41d4-a716-4466554400a1";

function keySession(createdAt) {
  const sid     = createLegacySseSession({ write: () => true, end: () => {} });
  const session = getLegacySession(sid);
  Object.assign(session, { authenticated: true, _keyId: KEY_ID, _groupKeyIds: [KEY_ID], createdAt });
  return sid;
}

async function post(sid) {
  const req   = Readable.from([Buffer.from("{not json")]);
  req.url     = `/message?sessionId=${sid}`;
  req.method  = "POST";
  req.headers = {};
  req.socket  = { remoteAddress: "192.0.2.10" };
  const res   = { statusCode: 0, body: "", setHeader() {}, end(b) { this.body = b ?? ""; } };
  await handleLegacySsePost(req, res);
  return res;
}

beforeEach(() => invalidateKeyState(KEY_ID));

describe("Legacy SSE 키 상태 재확인", () => {
  it("지난 퇴역 시각보다 먼저 만든 세션은 닫고 404다", async () => {
    keyState = { status: "active", secretRetirements: [new Date(Date.now() - 1000)] };
    const sid = keySession(Date.now() - 60_000);
    const res = await post(sid);
    assert.equal(res.statusCode, 404);
    assert.equal(getLegacySession(sid), undefined);
  });

  it("퇴역 시각 뒤에 만든 세션은 그대로 처리한다(본문 판독까지 간다)", async () => {
    keyState = { status: "active", secretRetirements: [new Date(Date.now() - 60_000)] };
    const sid = keySession(Date.now() - 1000);
    const res = await post(sid);
    assert.equal(res.statusCode, 400);
    assert.ok(getLegacySession(sid));
  });

  it("폐기한 키의 세션은 닫는다", async () => {
    keyState = { status: "inactive", revokedAt: new Date(), secretRetirements: [] };
    const sid = keySession(Date.now());
    assert.equal((await post(sid)).statusCode, 404);
  });
});
