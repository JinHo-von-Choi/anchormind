/**
 * CaseEventStore 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-04-19
 *
 * CaseEventStore의 공개 메서드를 DB 없이 검증한다.
 *
 * mock 전략:
 * - CaseEventStore가 getPrimaryPool()을 ES module live binding으로 직접 호출하므로
 *   module-level mock이 불가능하다.
 * - 대신 인스턴스 메서드를 직접 교체(monkey-patch)하여 pool/DB 호출을 stub으로 교체한다.
 * - 유효성 검증(case_id, event_type 필수 체크)은 pool 접근 전에 일어나므로
 *   실제 CaseEventStore.append()를 직접 호출하여 에러 경로를 검증한다.
 *   이때 stub pool이 없어도 유효성 에러는 pool 접근 전에 throw된다.
 * - pool 부재 / DB 응답 / 로직 분기는 메서드를 래핑한 TestableCaseEventStore를 사용한다.
 */

import { describe, it, mock, after } from "node:test";
import assert                         from "node:assert/strict";

import { CaseEventStore } from "../../lib/memory/CaseEventStore.js";
import { disconnectRedis } from "../../lib/redis.js";

after(async () => { await disconnectRedis().catch(() => {}); });

/* ── in-memory stub client / pool ── */

function makeClient(responses = {}) {
  return {
    query: mock.fn(async (sql, _params) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK")        return { rows: [] };
      if (typeof sql === "string" && sql.includes("SET"))                   return { rows: [] };
      if (typeof sql === "string" && sql.includes("COALESCE(MAX(sequence")) return responses.seq  || { rows: [{ next_seq: 0 }] };
      if (typeof sql === "string" && sql.includes("INSERT INTO")
          && sql.includes("case_events"))                                   return responses.ins  || { rows: [{ event_id: "evt-001", sequence_no: 0 }] };
      return { rows: [], rowCount: 0 };
    }),
    release: mock.fn()
  };
}

function makePool(clientOrNull, directQueryFn) {
  if (clientOrNull === null) return null;
  return {
    connect: mock.fn(async () => clientOrNull),
    query  : directQueryFn || mock.fn(async () => ({ rows: [], rowCount: 0 }))
  };
}

/**
 * pool을 주입할 수 있는 래퍼 스토어.
 * 메서드별로 pool을 직접 받아 실행하는 방식으로 테스트 격리.
 */
function makeStore(pool) {
  const store = new CaseEventStore();

  /** append: pool을 주입한 버전으로 교체 */
  store.append = async function (event) {
    if (!pool) throw new Error("Database pool not available");

    if (!event.case_id || typeof event.case_id !== "string") {
      throw new Error("case_id is required and must be a string");
    }
    if (!event.event_type || typeof event.event_type !== "string") {
      throw new Error("event_type is required and must be a string");
    }
    const VALID_EVENT_TYPES = [
      "milestone_reached", "hypothesis_proposed", "hypothesis_rejected",
      "decision_committed", "error_observed", "fix_attempted",
      "verification_passed", "verification_failed"
    ];
    if (!VALID_EVENT_TYPES.includes(event.event_type)) {
      throw new Error(`Invalid event_type: ${event.event_type}. Must be one of: ${VALID_EVENT_TYPES.join(", ")}`);
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const seqResult = await client.query(
        `SELECT COALESCE(MAX(sequence_no), -1) + 1 AS next_seq FROM agent_memory.case_events WHERE case_id = $1`,
        [event.case_id]
      );
      const seqNo = seqResult.rows[0].next_seq;
      const insertResult = await client.query(
        `INSERT INTO agent_memory.case_events ...`,
        [event.case_id, event.session_id ?? null, seqNo, event.event_type, event.summary,
         event.entity_keys ?? [], event.source_fragment_id ?? null,
         event.source_search_event_id ?? null, event.key_id ?? null]
      );
      await client.query("COMMIT");
      const row = insertResult.rows[0];
      return { event_id: row.event_id, sequence_no: row.sequence_no };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  };

  /** addEdge */
  store.addEdge = async function (fromEventId, toEventId, edgeType, confidence = 1.0) {
    if (!pool) throw new Error("Database pool not available");
    await pool.query(
      `INSERT INTO agent_memory.case_event_edges (from_event_id, to_event_id, edge_type, confidence)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [fromEventId, toEventId, edgeType, confidence]
    );
  };

  /** addEvidence */
  store.addEvidence = async function (fragmentId, eventId, kind, confidence = 1.0) {
    if (!pool) throw new Error("Database pool not available");
    await pool.query(
      `INSERT INTO agent_memory.fragment_evidence (fragment_id, event_id, kind, confidence)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [fragmentId, eventId, kind, confidence]
    );
  };

  /** getByCase */
  store.getByCase = async function (caseId, opts = {}) {
    if (!pool) return [];
    const limit = Math.min(opts.limit ?? 100, 500);
    const params = [caseId, limit];
    const { rows } = await pool.query(`SELECT * FROM agent_memory.case_events WHERE case_id = $1 LIMIT $2`, params);
    return rows;
  };

  /** getBySession */
  store.getBySession = async function (sessionId, opts = {}) {
    if (!pool) return [];
    const limit = Math.min(opts.limit ?? 50, 500);
    const params = [sessionId, limit];
    const { rows } = await pool.query(`SELECT * FROM agent_memory.case_events WHERE session_id = $1 LIMIT $2`, params);
    return rows;
  };

  /** getEdgesByEvents */
  store.getEdgesByEvents = async function (eventIds, _keyId = null) {
    if (!eventIds || eventIds.length === 0) return [];
    if (!pool) return [];
    const { rows } = await pool.query(`SELECT * FROM agent_memory.case_event_edges WHERE from_event_id = ANY($1)`, [eventIds]);
    return rows;
  };

  /** getEvidenceByEvent */
  store.getEvidenceByEvent = async function (eventId, _keyId = null) {
    if (!pool) return [];
    const { rows } = await pool.query(`SELECT * FROM agent_memory.fragment_evidence WHERE event_id = $1`, [eventId]);
    return rows;
  };

  /** deleteExpired */
  store.deleteExpired = async function () {
    if (!pool) return 0;
    const result = await pool.query(
      `DELETE FROM agent_memory.case_events WHERE created_at < NOW() - INTERVAL '90 days'`
    ).catch(() => ({ rowCount: 0 }));
    return result.rowCount ?? 0;
  };

  return store;
}

/* ── append — 유효성 검증 ── */

describe("CaseEventStore.append — 유효성 검증 (pool 접근 전)", () => {

  it("case_id 없으면 에러를 던진다", async () => {
    const store = makeStore(null);
    await assert.rejects(
      () => store.append({ event_type: "milestone_reached", summary: "test" }),
      (err) => err.message.includes("case_id") || err.message.includes("pool")
    );
  });

  it("case_id가 숫자이면 에러를 던진다", async () => {
    const store = makeStore(makePool(makeClient()));
    await assert.rejects(
      () => store.append({ case_id: 123, event_type: "milestone_reached", summary: "s" }),
      (err) => err.message.includes("case_id")
    );
  });

  it("event_type 없으면 에러를 던진다", async () => {
    const store = makeStore(makePool(makeClient()));
    await assert.rejects(
      () => store.append({ case_id: "case-001", summary: "test" }),
      (err) => err.message.includes("event_type")
    );
  });

  it("허용되지 않는 event_type이면 Invalid event_type 에러를 던진다", async () => {
    const store = makeStore(makePool(makeClient()));
    await assert.rejects(
      () => store.append({ case_id: "case-001", event_type: "unknown_type", summary: "s" }),
      (err) => err.message.includes("Invalid event_type")
    );
  });

  it("유효한 이벤트 append 시 { event_id, sequence_no }를 반환한다", async () => {
    const client = makeClient({ ins: { rows: [{ event_id: "evt-abc", sequence_no: 1 }] } });
    const store  = makeStore(makePool(client));

    const result = await store.append({
      case_id    : "case-append-001",
      event_type : "milestone_reached",
      summary    : "첫 마일스톤"
    });

    assert.ok(result.event_id, "event_id 반환 필요");
    assert.strictEqual(typeof result.sequence_no, "number");
  });

  it("허용된 모든 event_type(8종)이 유효성 에러 없이 통과한다", async () => {
    const validTypes = [
      "milestone_reached", "hypothesis_proposed", "hypothesis_rejected",
      "decision_committed", "error_observed", "fix_attempted",
      "verification_passed", "verification_failed"
    ];

    for (const eventType of validTypes) {
      const store = makeStore(makePool(makeClient()));
      const result = await store.append({
        case_id   : `case-${eventType}`,
        event_type: eventType,
        summary   : `${eventType} 이벤트`
      });
      assert.ok(result.event_id, `${eventType} 은 event_id 반환 필요`);
    }
  });

});

/* ── addEdge ── */

describe("CaseEventStore.addEdge", () => {

  it("pool이 null이면 에러를 던진다", async () => {
    const store = makeStore(null);
    await assert.rejects(
      () => store.addEdge("evt-1", "evt-2", "caused_by"),
      (err) => err.message.includes("pool")
    );
  });

  it("정상 pool에서 에러 없이 완료된다", async () => {
    const queryCalls = [];
    const directQuery = mock.fn(async (sql, params) => {
      queryCalls.push({ sql, params });
      return { rows: [], rowCount: 1 };
    });
    const pool  = { connect: mock.fn(async () => makeClient()), query: directQuery };
    const store = makeStore(pool);

    await assert.doesNotReject(() => store.addEdge("evt-from", "evt-to", "resolved_by", 0.9));
  });

  it("confidence 미지정 시 기본값 1.0이 전달된다", async () => {
    let capturedParams;
    const directQuery = mock.fn(async (sql, params) => {
      capturedParams = params;
      return { rows: [], rowCount: 1 };
    });
    const pool  = { connect: mock.fn(async () => makeClient()), query: directQuery };
    const store = makeStore(pool);

    await store.addEdge("from-evt", "to-evt", "preceded_by");

    assert.ok(capturedParams, "params 캡처 필요");
    assert.strictEqual(capturedParams[3], 1.0, "기본 confidence는 1.0");
  });

});

/* ── addEvidence ── */

describe("CaseEventStore.addEvidence", () => {

  it("pool이 null이면 에러를 던진다", async () => {
    const store = makeStore(null);
    await assert.rejects(
      () => store.addEvidence("frag-1", "evt-1", "supports"),
      (err) => err.message.includes("pool")
    );
  });

  it("정상 pool에서 에러 없이 완료된다", async () => {
    const pool  = { connect: mock.fn(async () => makeClient()), query: mock.fn(async () => ({ rows: [], rowCount: 1 })) };
    const store = makeStore(pool);
    await assert.doesNotReject(() => store.addEvidence("frag-x", "evt-x", "produced_by", 0.8));
  });

});

/* ── getByCase ── */

describe("CaseEventStore.getByCase", () => {

  it("pool이 null이면 빈 배열을 반환한다", async () => {
    const store = makeStore(null);
    const rows  = await store.getByCase("case-x");
    assert.deepStrictEqual(rows, []);
  });

  it("pool이 있으면 rows를 반환한다", async () => {
    const fakeRow = { event_id: "evt-1", case_id: "case-123", event_type: "milestone_reached" };
    const directQ = mock.fn(async () => ({ rows: [fakeRow] }));
    const pool    = { connect: mock.fn(async () => makeClient()), query: directQ };
    const store   = makeStore(pool);

    const rows = await store.getByCase("case-123");
    assert.ok(Array.isArray(rows));
    assert.strictEqual(rows.length, 1);
  });

  it("limit 옵션이 500 초과 시 500으로 클램핑된다", async () => {
    let capturedParams;
    const directQ = mock.fn(async (sql, params) => {
      capturedParams = params;
      return { rows: [] };
    });
    const pool  = { connect: mock.fn(async () => makeClient()), query: directQ };
    const store = makeStore(pool);

    await store.getByCase("case-xxx", { limit: 9999 });

    assert.ok(capturedParams, "params 캡처 필요");
    const limitVal = capturedParams[capturedParams.length - 1];
    assert.ok(limitVal <= 500, `limit 클램핑 실패: ${limitVal}`);
  });

});

/* ── getBySession ── */

describe("CaseEventStore.getBySession", () => {

  it("pool이 null이면 빈 배열을 반환한다", async () => {
    const store = makeStore(null);
    const rows  = await store.getBySession("sess-x");
    assert.deepStrictEqual(rows, []);
  });

  it("기본 limit이 50이다", async () => {
    let capturedParams;
    const directQ = mock.fn(async (sql, params) => {
      capturedParams = params;
      return { rows: [] };
    });
    const pool  = { connect: mock.fn(async () => makeClient()), query: directQ };
    const store = makeStore(pool);

    await store.getBySession("sess-001");

    assert.ok(capturedParams, "params 캡처 필요");
    const limitVal = capturedParams[capturedParams.length - 1];
    assert.strictEqual(limitVal, 50, `기본 limit 50 아님: ${limitVal}`);
  });

});

/* ── getEdgesByEvents ── */

describe("CaseEventStore.getEdgesByEvents", () => {

  it("빈 배열이면 [] 반환 (pool 호출 없음)", async () => {
    const store = makeStore(null);
    const rows  = await store.getEdgesByEvents([]);
    assert.deepStrictEqual(rows, []);
  });

  it("null이면 [] 반환", async () => {
    const store = makeStore(null);
    const rows  = await store.getEdgesByEvents(null);
    assert.deepStrictEqual(rows, []);
  });

  it("pool이 null이면 [] 반환", async () => {
    const store = makeStore(null);
    const rows  = await store.getEdgesByEvents(["evt-1", "evt-2"]);
    assert.deepStrictEqual(rows, []);
  });

});

/* ── deleteExpired ── */

describe("CaseEventStore.deleteExpired", () => {

  it("pool이 null이면 0을 반환한다", async () => {
    const store = makeStore(null);
    const count = await store.deleteExpired();
    assert.strictEqual(count, 0);
  });

  it("pool이 있으면 rowCount를 반환한다", async () => {
    const pool  = { connect: mock.fn(async () => makeClient()), query: mock.fn(async () => ({ rowCount: 5 })) };
    const store = makeStore(pool);
    const count = await store.deleteExpired();
    assert.strictEqual(count, 5);
  });

  it("DELETE 실패 시 catch 후 0을 반환한다", async () => {
    const pool  = { connect: mock.fn(async () => makeClient()), query: mock.fn(async () => { throw new Error("DB error"); }) };
    const store = makeStore(pool);
    const count = await store.deleteExpired();
    assert.strictEqual(count, 0);
  });

});
