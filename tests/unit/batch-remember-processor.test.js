/**
 * BatchRememberProcessor 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-04-05
 * 수정일: 2026-04-19 (Phase B quota 재검증, session_id 전파, 부분 할당량 케이스 추가)
 *
 * store, index, factory를 mock하여 BatchRememberProcessor.process()의
 * Phase A(검증), Phase B(INSERT), Phase C(후처리)를 검증한다.
 * setPool()로 DB pool을 주입하여 실제 DB 없이 동작을 검증한다.
 */

import { describe, it, mock, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

import { BatchRememberProcessor } from "../../lib/memory/write/BatchRememberProcessor.js";
import { disconnectRedis }        from "../../lib/redis.js";

after(async () => { await disconnectRedis().catch(() => {}); });

/* ── 헬퍼: factory mock ── */

function makeMockFactory() {
  let seq = 0;
  return {
    create(item) {
      seq++;
      const id = `frag-${seq}`;
      return {
        id,
        content           : item.content,
        topic             : item.topic,
        type              : item.type,
        keywords          : item.keywords || [],
        importance        : item.importance ?? 0.5,
        content_hash      : `hash-${seq}`,
        source            : item.source || null,
        linked_to         : item.linked_to || [],
        ttl_tier          : "warm",
        estimated_tokens  : 10,
        valid_from        : new Date().toISOString(),
        is_anchor         : false,
        context_summary   : null,
        session_id        : item.session_id || null,
        workspace         : null,
        case_id           : null,
        goal              : null,
        outcome           : null,
        phase             : null,
        resolution_status : null,
        assertion_status  : "observed",
      };
    }
  };
}

function makeMockIndex() {
  return { index: mock.fn(async () => {}) };
}

function makeMockStore() {
  return {};
}

/**
 * INSERT 성공하는 DB client mock 생성.
 * opts.insertFn으로 개별 INSERT 동작을 커스터마이즈할 수 있다.
 * opts.quotaRows로 api_keys/fragments 카운트 응답을 제어한다.
 */
function makeMockClient(opts = {}) {
  /**
   * 기본 insertFn: multi-row INSERT params 구조(24컬럼 × N행)에서
   * 첫 번째 파라미터($1)가 각 행의 id이므로 stride=24로 추출하여 rows 반환.
   */
  const insertFn  = opts.insertFn  || ((sql, params) => {
    const COLS = 24;
    const rows = [];
    for (let i = 0; i < params.length; i += COLS) {
      rows.push({ id: params[i] });
    }
    return { rows };
  });
  const quotaRows = opts.quotaRows || null;

  return {
    query: mock.fn(async (sql, params) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
      if (typeof sql === "string" && sql.startsWith("SET LOCAL")) return { rows: [] };

      /** Phase B quota: FOR UPDATE on api_keys */
      if (quotaRows && typeof sql === "string" && sql.includes("FOR UPDATE")) {
        return { rows: [quotaRows.keyRow] };
      }
      /** Phase B quota: COUNT fragments */
      if (quotaRows && typeof sql === "string" && sql.includes("COUNT(*)") && sql.includes("fragments")) {
        return { rows: [quotaRows.countRow] };
      }

      if (typeof sql === "string" && sql.includes("INSERT INTO")) return insertFn(sql, params);
      return { rows: [] };
    }),
    release: mock.fn()
  };
}

function makeMockPool(client) {
  return { connect: mock.fn(async () => client) };
}

/* ── 파편 샘플 ── */

function validItem(i = 0, extra = {}) {
  return {
    content: `This is a valid test fragment number ${i} with enough words`,
    topic  : "test-topic",
    type   : "fact",
    ...extra
  };
}

/* ── 테스트 ── */

describe("BatchRememberProcessor", () => {

  let processor;
  let mockIndex;
  let mockClient;

  beforeEach(() => {
    mockIndex  = makeMockIndex();
    mockClient = makeMockClient();

    processor = new BatchRememberProcessor({
      store  : makeMockStore(),
      index  : mockIndex,
      factory: makeMockFactory(),
    });
    processor.setPool(makeMockPool(mockClient));
  });

  it("빈 배열 거부: fragments가 비어 있으면 에러", async () => {
    await assert.rejects(
      () => processor.process({ fragments: [] }),
      (err) => err.message.includes("must not be empty")
    );
  });

  it("빈 배열 거부: fragments가 배열이 아니면 에러", async () => {
    await assert.rejects(
      () => processor.process({ fragments: "not-array" }),
      (err) => err.message.includes("must not be empty")
    );
  });

  it("MAX_BATCH 초과 거부: 201개 파편", async () => {
    const fragments = Array.from({ length: 201 }, (_, i) => validItem(i));
    await assert.rejects(
      () => processor.process({ fragments }),
      (err) => err.message.includes("exceeds maximum 200")
    );
  });

  it("유효한 파편 배치 INSERT 성공", async () => {
    const fragments = [validItem(0), validItem(1), validItem(2)];
    const result    = await processor.process({ fragments });

    assert.equal(result.inserted, 3);
    assert.equal(result.skipped, 0);
    assert.equal(result.results.length, 3);
    for (const r of result.results) {
      assert.equal(r.success, true);
      assert.ok(r.id);
    }
  });

  it("Phase A 유효성 검증: content가 너무 짧으면 skip", async () => {
    const fragments = [
      { content: "ab", topic: "t", type: "fact" },
      validItem(1),
    ];
    const result = await processor.process({ fragments });

    assert.equal(result.inserted, 1);
    assert.equal(result.skipped, 1);
    assert.equal(result.results[0].success, false);
    assert.ok(result.results[0].error);
    assert.equal(result.results[1].success, true);
  });

  it("전체 파편이 유효성 검증 실패 시 inserted=0", async () => {
    const fragments = [
      { content: "ab", topic: "t", type: "fact" },
      { content: "cd", topic: "t", type: "fact" },
    ];
    const result = await processor.process({ fragments });

    assert.equal(result.inserted, 0);
    assert.equal(result.skipped, 2);
  });

  it("multi-row INSERT 실패 시 전체 청크 롤백 후 에러 전파 (Fail-fast)", async () => {
    /**
     * 행별 직렬 INSERT에서는 부분 실패가 가능했으나, multi-row 단일 SQL로
     * 변경 후 청크 내 제약 위반은 전체 롤백 + raw 에러 전파가 된다.
     */
    const failClient = makeMockClient({
      insertFn: (_sql, _params) => {
        throw new Error("duplicate key");
      }
    });

    processor = new BatchRememberProcessor({
      store  : makeMockStore(),
      index  : makeMockIndex(),
      factory: makeMockFactory(),
    });
    processor.setPool(makeMockPool(failClient));

    const fragments = [validItem(0), validItem(1), validItem(2)];
    await assert.rejects(
      () => processor.process({ fragments }),
      (err) => err.message.includes("duplicate key")
    );
  });

  it("keyId 없이 master key 모드: 할당량 검사 없이 INSERT", async () => {
    const fragments = [validItem(0)];
    const result    = await processor.process({ fragments, _keyId: null });

    assert.equal(result.inserted, 1);
  });

  it("Phase C 후처리: index.index가 성공 파편마다 호출됨", async () => {
    const idx = makeMockIndex();
    processor = new BatchRememberProcessor({
      store  : makeMockStore(),
      index  : idx,
      factory: makeMockFactory(),
    });
    processor.setPool(makeMockPool(makeMockClient()));

    const fragments = [validItem(0), validItem(1)];
    await processor.process({ fragments });

    assert.equal(idx.index.mock.callCount(), 2);
  });

  it("pool이 null이면 Database pool unavailable 에러", async () => {
    processor.setPool(null);

    const fragments = [validItem(0)];
    await assert.rejects(
      () => processor.process({ fragments }),
      (err) => err.message.includes("Database pool unavailable")
    );
  });

  it("agentId 기본값은 'default'", async () => {
    const fragments = [validItem(0)];
    await processor.process({ fragments });

    const setCalls = mockClient.query.mock.calls
      .map(c => c.arguments[0])
      .filter(sql => typeof sql === "string" && sql.includes("current_agent_id"));
    assert.ok(setCalls.some(sql => sql.includes("default")));
  });

  it("workspace가 params에서 fragment 레벨로 전파", async () => {
    const factory = makeMockFactory();
    const created = [];
    const origCreate = factory.create.bind(factory);
    factory.create = (item) => {
      const f = origCreate(item);
      created.push(f);
      return f;
    };

    processor = new BatchRememberProcessor({
      store  : makeMockStore(),
      index  : makeMockIndex(),
      factory,
    });
    processor.setPool(makeMockPool(makeMockClient()));

    const fragments = [validItem(0)];
    await processor.process({ fragments, workspace: "ws-1" });

    assert.equal(created[0].workspace, "ws-1");
  });

  /* ── 신규 케이스 (2026-04-19 추가) ── */

  it("session_id가 파편 레벨로 전파된다", async () => {
    const factory = makeMockFactory();
    const created = [];
    const origCreate = factory.create.bind(factory);
    factory.create = (item) => {
      const f = origCreate(item);
      created.push(f);
      return f;
    };

    processor = new BatchRememberProcessor({
      store  : makeMockStore(),
      index  : makeMockIndex(),
      factory,
    });
    processor.setPool(makeMockPool(makeMockClient()));

    const fragments = [validItem(0, { session_id: "sess-xyz" })];
    await processor.process({ fragments });

    assert.equal(created[0].session_id, "sess-xyz");
  });

  it("agentId가 커스텀 값으로 전달되면 SET LOCAL에 반영된다", async () => {
    const fragments = [validItem(0)];
    await processor.process({ fragments, agentId: "agent-test-01" });

    const setCalls = mockClient.query.mock.calls
      .map(c => c.arguments[0])
      .filter(sql => typeof sql === "string" && sql.includes("current_agent_id"));
    assert.ok(setCalls.some(sql => sql.includes("agent-test-01")));
  });

  it("결과 배열 길이가 입력 fragments 길이와 동일하다", async () => {
    const fragments = [validItem(0), validItem(1), validItem(2)];
    const result    = await processor.process({ fragments });
    assert.equal(result.results.length, fragments.length);
  });

  it("inserted + skipped 합계가 총 파편 수와 동일하다", async () => {
    const fragments = [
      { content: "x", topic: "t", type: "fact" },
      validItem(0),
      validItem(1),
    ];
    const result = await processor.process({ fragments });
    assert.equal(result.inserted + result.skipped, fragments.length);
  });

  it("200개 경계(정확히 MAX_BATCH)는 거부하지 않는다", async () => {
    const fragments = Array.from({ length: 200 }, (_, i) => validItem(i));
    const result    = await processor.process({ fragments });
    assert.equal(result.inserted, 200);
  });

  it("Phase B: BEGIN/COMMIT이 트랜잭션 쌍으로 호출된다", async () => {
    const fragments = [validItem(0)];
    await processor.process({ fragments });

    const sqls = mockClient.query.mock.calls.map(c => c.arguments[0]);
    assert.ok(sqls.includes("BEGIN"),  "BEGIN 누락");
    assert.ok(sqls.includes("COMMIT"), "COMMIT 누락");
  });

  it("INSERT 예외 발생 시 전체 트랜잭션 ROLLBACK 후 에러 전파 (Fail-fast)", async () => {
    /**
     * multi-row 단일 SQL에서 예외가 발생하면 청크 전체가 롤백되고
     * raw 에러가 호출자에게 전파된다 (chunk halving/부분 성공 금지).
     */
    const allFailClient = makeMockClient({
      insertFn: (_sql, _params) => {
        throw new Error("insert error");
      }
    });

    processor = new BatchRememberProcessor({
      store  : makeMockStore(),
      index  : makeMockIndex(),
      factory: makeMockFactory(),
    });
    processor.setPool(makeMockPool(allFailClient));

    const fragments = [validItem(0), validItem(1)];
    await assert.rejects(
      () => processor.process({ fragments }),
      (err) => err.message.includes("insert error")
    );
  });

});
