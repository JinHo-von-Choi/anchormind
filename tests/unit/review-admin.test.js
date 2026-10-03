/**
 * 검토 대기열 관리 API와 결정 저장소 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 결정 요청 검증, 승인과 거절의 한 트랜잭션 적용(상태 확인, 앵커 요청 적용, 결정 기록), 멱등 키 재요청과
 * 충돌, 메모 마스킹, 목록 질의, 30일 미결정 자동 거절, 라우트 표를 DB 대역 위에서 본다.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert                                  from "node:assert/strict";
import { readFileSync }                        from "node:fs";

import {
  decideReview,
  listReviewQueue,
  expireStaleReviews,
  runReviewExpiry,
  sanitizeReviewNote,
  parseReviewCursor,
  ReviewNotFoundError,
  ReviewStateError,
  ReviewIdempotencyConflictError,
  REVIEW_NOTE_MAX
} from "../../lib/admin/ReviewStore.js";
import {
  parseDecisionBody,
  parseListQuery,
  reviewerLabel,
  handleReview,
  REVIEW_ROUTES,
  ReviewInputError
} from "../../lib/admin/admin-review.js";
import { ADMIN_BASE }          from "../../lib/admin/admin-auth.js";
import { reviewDecisionTotal } from "../../lib/memory/write/write-gate-metrics.js";

const SECRET = `sk-ant-api03-${"A1b2".repeat(20)}`;

/**
 * 트랜잭션 대역. responder(sql, params)가 돌려준 행을 결과로 쓴다.
 *
 * @param {(sql: string, params: Array) => (Object[]|Error)} responder
 */
function fakePool(responder) {
  const statements = [];
  const client = {
    query: async (sql, params = []) => {
      statements.push({ sql, params });
      if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [] };
      const out = responder(sql, params);
      if (out instanceof Error) throw out;
      return { rows: out ?? [], rowCount: (out ?? []).length };
    },
    release: () => {}
  };
  return { statements, pool: { connect: async () => client, query: client.query } };
}

const decisionRow = (extra = {}) => ({
  id: 7, fragment_id: "f1", decision: "approve", reviewer: "master:c1", key_id: "k1", decided_at: new Date("2026-10-03T00:00:00Z"), ...extra
});

/** 검토 대기 파편 하나가 있는 저장소 응답기 */
function pendingResponder({ state = "pending", reason = "instruction_override", validTo = null, replay = null, missing = false } = {}) {
  return (sql) => {
    if (/FROM \S*memory_review_decisions\s+WHERE idempotency_key/.test(sql)) return replay ? [replay] : [];
    if (/FOR UPDATE$/.test(sql.trim())) return missing ? [] : [{ id: "f1", key_id: "k1", review_state: state, review_reason: reason, valid_to: validTo }];
    if (/^UPDATE/.test(sql.trim())) return [];
    if (/INSERT INTO \S*memory_review_decisions/.test(sql)) return [decisionRow()];
    return [];
  };
}

describe("결정 요청 검증", () => {
  it("메모와 멱등 키를 받고 본문 키가 헤더보다 앞선다", () => {
    assert.deepEqual(parseDecisionBody({ note: "ok", idempotencyKey: "a-1" }, { "idempotency-key": "h-1" }), { note: "ok", idempotencyKey: "a-1" });
    assert.deepEqual(parseDecisionBody(null, { "idempotency-key": "h-1" }), { note: null, idempotencyKey: "h-1" });
    assert.deepEqual(parseDecisionBody({}), { note: null, idempotencyKey: null });
  });

  it("모르는 필드, 긴 메모, 허용 밖 멱등 키, 배열 본문은 field와 함께 거부한다", () => {
    const cases = [
      [{ decision: "approve" }, "decision"],
      [{ note: "x".repeat(REVIEW_NOTE_MAX + 1) }, "note"],
      [{ note: 3 }, "note"],
      [{ idempotencyKey: "a b" }, "idempotencyKey"],
      [{ idempotencyKey: "x".repeat(129) }, "idempotencyKey"],
      [[], "body"]
    ];
    for (const [body, field] of cases) {
      assert.throws(() => parseDecisionBody(body), (err) => err instanceof ReviewInputError && err.field === field, JSON.stringify(body).slice(0, 40));
    }
  });

  it("목록 질의는 limit 범위, key_id 형식, 이어 보기 표지를 검증한다", () => {
    assert.deepEqual(parseListQuery(new URLSearchParams("")), { keyId: null, master: false, limit: 50, cursor: null });
    assert.deepEqual(parseListQuery(new URLSearchParams("key_id=master&limit=10")), { keyId: null, master: true, limit: 10, cursor: null });
    assert.equal(parseListQuery(new URLSearchParams("key_id=k-1")).keyId, "k-1");
    for (const [query, field] of [["limit=0", "limit"], ["limit=201", "limit"], ["limit=x", "limit"], ["key_id=a%20b", "key_id"], ["cursor=bad", "cursor"]]) {
      assert.throws(() => parseListQuery(new URLSearchParams(query)), (err) => err.field === field, query);
    }
    assert.deepEqual(parseReviewCursor("2026-10-01T00:00:00.000Z|f9"), { createdAt: "2026-10-01T00:00:00.000Z", id: "f9" });
  });

  it("결정자 표기는 관리 행위자에서 만든다", () => {
    assert.equal(reviewerLabel({ keyId: "master", sessionId: "c1234567" }), "master:c1234567");
    assert.equal(reviewerLabel({ keyId: "master", sessionId: null }), "master:unknown");
  });
});

describe("결정 적용", () => {
  it("승인은 대상 행을 잠그고 approved로 바꾼 뒤 결정을 기록한다", async () => {
    const { statements, pool } = fakePool(pendingResponder());
    const result = await decideReview({ fragmentId: "f1", decision: "approve", reviewer: "master:c1" }, pool);
    assert.equal(result.replayed, false);
    assert.equal(result.anchorApplied, false);
    const sqls = statements.map(s => s.sql.trim());
    assert.equal(sqls[0], "BEGIN");
    assert.ok(sqls.some(s => /FOR UPDATE$/.test(s)));
    const update = statements.find(s => /^UPDATE/.test(s.sql.trim()));
    assert.match(update.sql, /review_state = \$2, is_anchor = \(is_anchor OR \$3::boolean\)/);
    assert.deepEqual(update.params, ["f1", "approved", false]);
    const insert = statements.find(s => /INSERT INTO/.test(s.sql));
    assert.deepEqual(insert.params, ["f1", "approve", "master:c1", null, null, "k1", "instruction_override"]);
    assert.equal(sqls.at(-1), "COMMIT");
  });

  it("앵커 요청 표지가 있는 파편은 승인할 때 앵커로 지정한다", async () => {
    const { statements, pool } = fakePool(pendingResponder({ reason: "low_trust_directive,anchor_requested" }));
    const result = await decideReview({ fragmentId: "f1", decision: "approve", reviewer: "master:c1" }, pool);
    assert.equal(result.anchorApplied, true);
    assert.equal(statements.find(s => /^UPDATE/.test(s.sql.trim())).params[2], true);
  });

  it("거절은 rejected와 valid_to를 함께 설정한다", async () => {
    const { statements, pool } = fakePool(pendingResponder());
    await decideReview({ fragmentId: "f1", decision: "reject", reviewer: "master:c1", note: "지시 덮어쓰기" }, pool);
    const update = statements.find(s => /^UPDATE/.test(s.sql.trim()));
    assert.match(update.sql, /review_state = \$2, valid_to = NOW\(\)/);
    assert.deepEqual(update.params, ["f1", "rejected"]);
  });

  it("검토 대기가 아니거나 만료된 파편은 상태 충돌, 없는 파편은 없음으로 되돌린다", async () => {
    for (const opts of [{ state: "approved" }, { state: null }, { validTo: new Date() }]) {
      const { statements, pool } = fakePool(pendingResponder(opts));
      await assert.rejects(decideReview({ fragmentId: "f1", decision: "approve", reviewer: "r" }, pool), ReviewStateError);
      assert.ok(!statements.some(s => /^UPDATE|INSERT/.test(s.sql.trim())));
      assert.equal(statements.at(-1).sql, "ROLLBACK");
    }
    const { pool } = fakePool(pendingResponder({ missing: true }));
    await assert.rejects(decideReview({ fragmentId: "f1", decision: "approve", reviewer: "r" }, pool), ReviewNotFoundError);
  });

  it("같은 멱등 키의 재요청은 앞선 결정을 돌려주고 파편을 다시 바꾸지 않는다", async () => {
    const { statements, pool } = fakePool(pendingResponder({ replay: decisionRow() }));
    const result = await decideReview({ fragmentId: "f1", decision: "approve", reviewer: "r", idempotencyKey: "k-1" }, pool);
    assert.equal(result.replayed, true);
    assert.equal(result.decisionId, "7");
    assert.ok(!statements.some(s => /FOR UPDATE|^UPDATE/.test(s.sql.trim())));
  });

  it("다른 결정에 쓰인 멱등 키는 충돌이다", async () => {
    const { pool } = fakePool(pendingResponder({ replay: decisionRow({ decision: "reject" }) }));
    await assert.rejects(decideReview({ fragmentId: "f1", decision: "approve", reviewer: "r", idempotencyKey: "k-1" }, pool), ReviewIdempotencyConflictError);
  });

  it("동시 요청이 고유 색인에서 지면 앞선 결정을 돌려준다", async () => {
    let inserted = false;
    const responder = (sql) => {
      if (/WHERE idempotency_key/.test(sql)) return inserted ? [decisionRow()] : [];
      if (/INSERT INTO/.test(sql)) { inserted = true; return Object.assign(new Error("dup"), { code: "23505" }); }
      return pendingResponder()(sql);
    };
    const { pool } = fakePool(responder);
    const result = await decideReview({ fragmentId: "f1", decision: "approve", reviewer: "r", idempotencyKey: "k-1" }, pool);
    assert.equal(result.replayed, true);
  });

  it("실제 결정만 결정 지표에 센다", async () => {
    const count = async () => (await reviewDecisionTotal.get()).values.filter(v => v.labels.decision === "approve").reduce((a, v) => a + v.value, 0);
    const before = await count();
    await decideReview({ fragmentId: "f1", decision: "approve", reviewer: "r" }, fakePool(pendingResponder()).pool);
    await decideReview({ fragmentId: "f1", decision: "approve", reviewer: "r", idempotencyKey: "k" }, fakePool(pendingResponder({ replay: decisionRow() })).pool);
    assert.equal(await count(), before + 1);
  });

  it("모르는 결정 값은 형식 오류다", async () => {
    await assert.rejects(decideReview({ fragmentId: "f1", decision: "edit", reviewer: "r" }, fakePool(() => []).pool), TypeError);
  });
});

describe("결정 메모", () => {
  it("비밀을 가리고 제어 문자를 지우며 길이를 자른다", () => {
    const masked = sanitizeReviewNote(`키가 섞였다 ${SECRET}\u0007`);
    assert.equal(masked.includes(SECRET), false);
    assert.equal(masked.includes(String.fromCharCode(7)), false);
    assert.equal(Array.from(sanitizeReviewNote("가".repeat(800))).length, REVIEW_NOTE_MAX);
    assert.equal(sanitizeReviewNote("  "), null);
    assert.equal(sanitizeReviewNote(5), null);
  });
});

describe("목록과 자동 거절", () => {
  it("목록은 검토 대기와 유효 파편만 오래된 순으로 읽고 이어 보기 표지를 만든다", async () => {
    const created = new Date("2026-09-01T00:00:00Z");
    const { statements, pool } = fakePool(() => [{ id: "a", created_at: created, review_reason: "instruction_override,anchor_requested" }]);
    const result = await listReviewQueue({ keyId: "k1", limit: 1, cursor: { createdAt: "2026-08-01T00:00:00.000Z", id: "z" } }, pool);
    const { sql, params } = statements[0];
    assert.match(sql, /f\.review_state = 'pending' AND f\.valid_to IS NULL AND f\.key_id = \$2 AND \(f\.created_at, f\.id\) > \(\$3::timestamptz, \$4\)/);
    assert.match(sql, /ORDER BY f\.created_at ASC, f\.id ASC/);
    assert.deepEqual(params, [30, "k1", "2026-08-01T00:00:00.000Z", "z", 1]);
    assert.equal(result.nextCursor, `${created.toISOString()}|a`);
    assert.deepEqual(result.items[0].review_reasons, ["instruction_override", "anchor_requested"]);
  });

  it("마스터 필터는 key_id IS NULL이고 마지막 쪽에는 이어 보기 표지가 없다", async () => {
    const { statements, pool } = fakePool(() => []);
    const result = await listReviewQueue({ master: true }, pool);
    assert.match(statements[0].sql, /f\.key_id IS NULL/);
    assert.equal(result.nextCursor, null);
  });

  it("자동 거절은 id 순으로 잠그되 잠긴 행을 건너뛰고 갱신과 결정 기록을 나눠 쓴다", async () => {
    const { statements, pool } = fakePool((sql) => {
      if (/FOR UPDATE SKIP LOCKED/.test(sql)) return [{ id: "a" }, { id: "b" }];
      if (/^UPDATE/.test(sql.trim())) return [{ id: "a", key_id: "k1", review_reason: "mode_all" }, { id: "b", key_id: null, review_reason: "instruction_override" }];
      return [];
    });
    const result = await expireStaleReviews({}, pool);
    assert.deepEqual(result, { rejected: 2, fragmentIds: ["a", "b"] });
    const lock = statements.find(s => /SKIP LOCKED/.test(s.sql));
    assert.match(lock.sql, /created_at < NOW\(\) - make_interval\(days => \$1\)[\s\S]*ORDER BY id/);
    assert.deepEqual(lock.params, [30, 500]);
    const update = statements.find(s => /^UPDATE/.test(s.sql.trim()));
    assert.match(update.sql, /SET review_state = 'rejected', valid_to = NOW\(\)/);
    const insert = statements.find(s => /INSERT INTO/.test(s.sql));
    assert.match(insert.sql, /'auto_reject', 'system'/);
    assert.deepEqual(insert.params, [["a", "b"], ["k1", null], ["mode_all", "instruction_override"]]);
  });

  it("대상이 없으면 갱신하지 않는다", async () => {
    const { statements, pool } = fakePool(() => []);
    assert.deepEqual(await expireStaleReviews({}, pool), { rejected: 0, fragmentIds: [] });
    assert.ok(!statements.some(s => /^UPDATE|INSERT/.test(s.sql.trim())));
  });

  describe("주기 작업", () => {
    const saved = process.env.MEMENTO_REVIEW_QUEUE;
    beforeEach(() => { delete process.env.MEMENTO_REVIEW_QUEUE; });
    afterEach(() => {
      if (saved === undefined) delete process.env.MEMENTO_REVIEW_QUEUE;
      else process.env.MEMENTO_REVIEW_QUEUE = saved;
    });

    it("실패는 던지지 않고 0으로 끝난다", async () => {
      assert.equal(await runReviewExpiry(async () => { throw new Error("db down"); }), 0);
      assert.equal(await runReviewExpiry(async () => ({ rejected: 0, fragmentIds: [] })), 0);
    });

    it("MEMENTO_REVIEW_QUEUE=off이면 자동 거절을 부르지 않는다", async () => {
      process.env.MEMENTO_REVIEW_QUEUE = "off";
      let called = false;
      assert.equal(await runReviewExpiry(async () => { called = true; return { rejected: 1, fragmentIds: ["a"] }; }), 0);
      assert.equal(called, false);
    });
  });
});

describe("라우트", () => {
  /** 응답 대역 */
  function fakeRes() {
    return { statusCode: 0, body: null, end(text) { this.body = JSON.parse(text); } };
  }

  it("라우트 표는 목록 GET과 승인, 거절 POST 세 가지다", () => {
    assert.deepEqual(REVIEW_ROUTES.map(r => r.method), ["GET", "POST", "POST"]);
    assert.ok(REVIEW_ROUTES[0].match(`${ADMIN_BASE}/review`));
    assert.deepEqual([...REVIEW_ROUTES[1].match(`${ADMIN_BASE}/review/f1/approve`)].slice(1), ["f1"]);
    assert.deepEqual([...REVIEW_ROUTES[2].match(`${ADMIN_BASE}/review/f1/reject`)].slice(1), ["f1"]);
    assert.equal(REVIEW_ROUTES[1].match(`${ADMIN_BASE}/review/f1/edit`), null);
  });

  it("잘못된 목록 질의는 DB에 닿기 전에 400과 field로 끝난다", async () => {
    const res = fakeRes();
    const url = new URL(`http://localhost${ADMIN_BASE}/review?limit=999`);
    assert.equal(await handleReview({ method: "GET", url: url.pathname + url.search, headers: {} }, res, url), true);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.field, "limit");
  });

  it("다른 경로와 메서드는 처리하지 않는다", async () => {
    const res = fakeRes();
    assert.equal(await handleReview({ method: "DELETE", url: "/", headers: {} }, res, new URL(`http://localhost${ADMIN_BASE}/review`)), false);
    assert.equal(await handleReview({ method: "GET", url: "/", headers: {} }, res, new URL(`http://localhost${ADMIN_BASE}/keys`)), false);
  });

  it("관리 API 라우터가 검토 핸들러를 모듈 핸들러 표에 둔다", () => {
    const src = readFileSync(new URL("../../lib/admin/admin-routes.js", import.meta.url), "utf8");
    const table = src.slice(src.indexOf("const MODULE_HANDLERS"), src.indexOf("]);", src.indexOf("const MODULE_HANDLERS")));
    assert.match(table, /handleKeys, handleReview,/);
  });
});
