/**
 * 세션 회전 지표 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * mcp_session_rotation_total{outcome}와 mcp_rotate_rate_limited_total이
 * /metrics 레지스트리에 등록되고, outcome 값이 고정 집합 안에 머무는지 검증한다.
 */

import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";

process.env.DOTENV_CONFIG_PATH      ??= ".env.test";
process.env.MEMENTO_METRICS_DEFAULT ??= "off";
process.env.REDIS_ENABLED           ??= "false";
process.env.CACHE_ENABLED           ??= "false";

const state = {
  rotate: async () => ({ oldSessionId: "old", newSessionId: "new", expiresAt: 1 }),
  send:   async () => {}
};

const realSessions    = await import("../../lib/sessions.js");
const realAuth        = await import("../../lib/auth.js");
const realCompression = await import("../../lib/compression.js");

mock.module("../../lib/sessions.js", {
  namedExports: { ...realSessions, rotateSession: (...args) => state.rotate(...args) }
});
mock.module("../../lib/auth.js", {
  namedExports: { ...realAuth, validateAuthentication: async () => ({ valid: true, keyId: "k" }) }
});
mock.module("../../lib/compression.js", {
  namedExports: { ...realCompression, sendJSON: (...args) => state.send(...args) }
});

const {
  register,
  recordSessionRotation,
  recordRotateRateLimited
} = await import("../../lib/metrics.js");
const { handleSessionRotate }                 = await import("../../lib/handlers/session-handler.js");
const { _resetForTest: resetRotateRateLimit } = await import("../../lib/handlers/_rotate-ratelimit.js");

const OUTCOMES = new Set(["rotated", "not_found", "expired", "forbidden", "unavailable", "error"]);

describe("세션 회전 지표", () => {
  it("recordSessionRotation은 outcome 라벨 하나로 카운트한다", async () => {
    recordSessionRotation("rotated");
    recordSessionRotation("not_found");
    const metric = register.getSingleMetric("mcp_session_rotation_total");
    assert.ok(metric, "mcp_session_rotation_total 미등록");
    const { values } = await metric.get();
    assert.ok(values.length >= 2);
    for (const v of values) {
      assert.deepEqual(Object.keys(v.labels), ["outcome"]);
      assert.ok(OUTCOMES.has(v.labels.outcome), `허용 집합 밖의 값: ${v.labels.outcome}`);
    }
    assert.ok(values.find(v => v.labels.outcome === "rotated").value >= 1);
  });

  it("recordRotateRateLimited는 라벨 없는 카운터를 올린다", async () => {
    recordRotateRateLimited();
    const metric = register.getSingleMetric("mcp_rotate_rate_limited_total");
    assert.ok(metric, "mcp_rotate_rate_limited_total 미등록");
    const { values } = await metric.get();
    assert.equal(values.length, 1);
    assert.deepEqual(values[0].labels, {});
    assert.ok(values[0].value >= 1);
  });

  it("두 지표가 /metrics 노출 텍스트에 나온다", async () => {
    recordSessionRotation("error");
    const text = await register.metrics();
    assert.match(text, /^mcp_session_rotation_total\{outcome="error"\} \d+/m);
    assert.match(text, /^mcp_rotate_rate_limited_total \d+/m);
  });
});

/**
 * 회전 결과 카운터와 rate limit 카운터의 현재 값을 읽는다.
 *
 * @returns {Promise<{ outcomes: Record<string, number>, limited: number }>}
 */
async function readCounters() {
  const rotation = (await register.getSingleMetric("mcp_session_rotation_total").get()).values;
  const limited  = (await register.getSingleMetric("mcp_rotate_rate_limited_total").get()).values;
  const outcomes = {};
  for (const v of rotation) outcomes[v.labels.outcome] = v.value;
  return { outcomes, limited: limited[0]?.value ?? 0 };
}

/**
 * 호출 전후 카운터 증가분을 계산한다. 증가한 outcome만 담는다.
 */
function diffCounters(before, after) {
  const outcomes = {};
  for (const [k, v] of Object.entries(after.outcomes)) {
    const d = v - (before.outcomes[k] ?? 0);
    if (d !== 0) outcomes[k] = d;
  }
  return { outcomes, limited: after.limited - before.limited };
}

function makeReq() {
  const req   = Readable.from([]);
  req.headers = { origin: "http://localhost", "mcp-session-id": "sess-0123456789" };
  req.socket  = { remoteAddress: "127.0.0.1" };
  return req;
}

function makeRes() {
  return { headers: {}, setHeader(k, v) { this.headers[k] = v; } };
}

/**
 * 핸들러를 한 번 구동하고 응답 상태와 카운터 증가분을 돌려준다.
 */
async function drive({ rotate, send } = {}) {
  const sent = [];
  if (rotate) state.rotate = rotate;
  state.send = send ?? (async (_res, status, body) => { sent.push({ status, body }); });
  const before = await readCounters();
  let thrown = null;
  try {
    await handleSessionRotate(makeReq(), makeRes());
  } catch (err) {
    thrown = err;
  }
  const delta = diffCounters(before, await readCounters());
  return { sent, thrown, delta };
}

function failWith(statusCode) {
  return async () => { throw Object.assign(new Error(`rotate ${statusCode}`), { statusCode }); };
}

describe("handleSessionRotate 결과 기록", () => {
  beforeEach(() => resetRotateRateLimit());
  afterEach(() => { delete process.env.MEMENTO_ROTATE_RATE_LIMIT_PER_MIN; });

  const cases = [
    { name: "성공",                 rotate: undefined,        status: 200, outcome: "rotated" },
    { name: "세션 없음",            rotate: failWith(404),    status: 404, outcome: "not_found" },
    { name: "세션 만료",            rotate: failWith(401),    status: 401, outcome: "expired" },
    { name: "신원 불일치",          rotate: failWith(403),    status: 403, outcome: "forbidden" },
    { name: "영속 계층 불가",       rotate: failWith(503),    status: 503, outcome: "unavailable" },
    { name: "예상 밖 오류",         rotate: async () => { throw new Error("boom"); }, status: 500, outcome: "error" }
  ];

  for (const c of cases) {
    it(`${c.name}: ${c.status} 응답과 ${c.outcome} 한 건만 기록한다`, async () => {
      const { sent, thrown, delta } = await drive({
        rotate: c.rotate ?? (async () => ({ oldSessionId: "old", newSessionId: "new", expiresAt: 1 }))
      });
      assert.equal(thrown, null);
      assert.equal(sent.length, 1);
      assert.equal(sent[0].status, c.status);
      assert.deepEqual(delta.outcomes, { [c.outcome]: 1 });
      assert.equal(delta.limited, 0);
    });
  }

  it("성공 후 응답 기록이 실패해도 rotated 한 건만 기록한다", async () => {
    let calls = 0;
    const { delta } = await drive({
      rotate: async () => ({ oldSessionId: "old", newSessionId: "new", expiresAt: 1 }),
      send:   async () => { calls += 1; throw new Error("socket closed"); }
    });
    assert.ok(calls >= 1);
    assert.deepEqual(delta.outcomes, { rotated: 1 });
  });

  it("rate limit 초과 시 429와 제한 카운터만 올린다", async () => {
    process.env.MEMENTO_ROTATE_RATE_LIMIT_PER_MIN = "1";
    await drive();
    const { sent, delta } = await drive();
    assert.equal(sent[0].status, 429);
    assert.deepEqual(delta.outcomes, {});
    assert.equal(delta.limited, 1);
  });
});
