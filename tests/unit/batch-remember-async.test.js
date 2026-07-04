/**
 * batch_remember async(파이어앤포겟) 모드 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-06-15
 *
 * 검증 범위:
 *  - batchRememberDefinition 스키마에 async boolean 파라미터 노출
 *  - async=true: 선검증 통과분 Redis 큐 적재 + 즉시 { async, accepted, rejected, jobId } 반환
 *  - async=true: 스키마 위반 파편은 동기 거부(rejected)되고 통과분만 적재
 *  - Redis 비활성(stub) 시 async=true여도 동기 경로로 폴백
 */

import { describe, it, mock, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

import { BatchRememberProcessor } from "../../lib/memory/write/BatchRememberProcessor.js";
import { redisClient, disconnectRedis } from "../../lib/redis.js";

after(async () => { await disconnectRedis().catch(() => {}); });

/* ── mock 헬퍼 (batch-remember-processor.test.js 와 동일 패턴) ── */

function makeMockFactory() {
  let seq = 0;
  return {
    create(item) {
      seq++;
      return {
        id                : `frag-${seq}`,
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
        idempotency_key   : item.idempotencyKey ?? null,
      };
    }
  };
}

function makeMockIndex() {
  return { index: mock.fn(async () => {}) };
}

/** 동기 INSERT 경로용 mock client (24컬럼 stride로 id 추출) */
function makeMockClient() {
  return {
    query: mock.fn(async (sql, params) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
      if (typeof sql === "string" && sql.startsWith("SET LOCAL")) return { rows: [] };
      if (typeof sql === "string" && sql.includes("INSERT INTO")) {
        const COLS = 24;
        const rows = [];
        for (let i = 0; i < params.length; i += COLS) rows.push({ id: params[i] });
        return { rows };
      }
      return { rows: [] };
    }),
    release: mock.fn()
  };
}

function validItem(i = 0, extra = {}) {
  return {
    content: `This is a valid test fragment number ${i} with enough words`,
    topic  : "test-topic",
    type   : "fact",
    ...extra
  };
}

/**
 * redisClient.status 와 lpush 를 일시적으로 mock하여 "Redis 활성" 환경을 흉내낸다.
 * 반환된 restore()를 호출하면 원래 상태로 복구한다.
 *
 * @returns {{ pushed: Array<{key:string, value:object}>, restore: () => void }}
 */
function mockRedisActive() {
  const pushed       = [];
  const origStatus   = redisClient.status;
  const origLpush    = redisClient.lpush;

  redisClient.status = "ready";
  redisClient.lpush  = mock.fn(async (key, value) => {
    pushed.push({ key, value: JSON.parse(value) });
    return pushed.length;
  });

  return {
    pushed,
    restore() {
      redisClient.status = origStatus;
      redisClient.lpush  = origLpush;
    }
  };
}

/* ── 테스트 ── */

describe("batch_remember async 스키마", () => {
  it("batchRememberDefinition 이 async boolean 파라미터를 노출한다", async () => {
    const { batchRememberDefinition } = await import("../../lib/tools/memory-schemas.js");
    const props = batchRememberDefinition.inputSchema.properties;
    assert.ok(props.async, "async 프로퍼티 누락");
    assert.equal(props.async.type, "boolean");
    assert.ok(/REDIS_ENABLED=false/.test(props.async.description), "폴백 트레이드오프 설명 누락");
  });
});

describe("BatchRememberProcessor async=true (Redis 활성)", () => {
  let processor;

  beforeEach(() => {
    processor = new BatchRememberProcessor({
      store  : {},
      index  : makeMockIndex(),
      factory: makeMockFactory(),
    });
    /** async 경로는 DB pool에 접근하지 않아야 하므로 pool을 주입하지 않는다. */
  });

  it("선검증 통과분을 큐에 적재하고 { async, accepted, rejected, jobId } 를 즉시 반환한다", async () => {
    const redis = mockRedisActive();
    try {
      const result = await processor.process({
        async    : true,
        fragments: [validItem(0), validItem(1)]
      });

      assert.equal(result.async, true);
      assert.equal(result.accepted, 2);
      assert.equal(result.rejected.length, 0);
      assert.ok(result.jobId, "jobId 누락");
      assert.equal(redis.pushed.length, 1, "큐 push 1회");

      const job = redis.pushed[0].value;
      assert.equal(job.jobId, result.jobId);
      assert.equal(job.params.fragments.length, 2, "원본 item 2건 적재");
      /** job에 async 플래그가 없어야 워커가 동기 경로로 재실행한다 (무한 재적재 방지) */
      assert.equal(job.params.async, undefined, "job params에 async 플래그가 있으면 안 됨");
    } finally {
      redis.restore();
    }
  });

  it("스키마 위반 파편은 동기 거부되고 통과분만 적재된다", async () => {
    const redis = mockRedisActive();
    try {
      const result = await processor.process({
        async    : true,
        fragments: [
          validItem(0),
          { content: null, topic: "t", type: "fact" },   // content 누락
          { content: "valid but no type", topic: "t" }    // type 누락
        ]
      });

      assert.equal(result.async, true);
      assert.equal(result.accepted, 1, "유효 1건만 적재");
      assert.equal(result.rejected.length, 2, "거부 2건");
      assert.ok(result.rejected.every(r => typeof r.error === "string" && r.error.length > 0));
      assert.equal(redis.pushed[0].value.params.fragments.length, 1);
    } finally {
      redis.restore();
    }
  });

  it("idempotencyKey 가 원본 item 그대로 큐에 보존된다", async () => {
    const redis = mockRedisActive();
    try {
      const result = await processor.process({
        async    : true,
        fragments: [validItem(0, { idempotencyKey: "import-2026-06-15-001" })]
      });

      assert.equal(result.accepted, 1);
      const queuedItem = redis.pushed[0].value.params.fragments[0];
      assert.equal(queuedItem.idempotencyKey, "import-2026-06-15-001");
    } finally {
      redis.restore();
    }
  });

  it("전량 거부 시 accepted=0, jobId=null, 큐 미적재", async () => {
    const redis = mockRedisActive();
    try {
      const result = await processor.process({
        async    : true,
        fragments: [{ content: null, topic: "t", type: "fact" }]
      });

      assert.equal(result.accepted, 0);
      assert.equal(result.jobId, null);
      assert.equal(result.rejected.length, 1);
      assert.equal(redis.pushed.length, 0, "전량 거부 시 큐 push 없음");
    } finally {
      redis.restore();
    }
  });
});

describe("BatchRememberProcessor async=true Redis 폴백", () => {
  it("redisClient.status === 'stub' 이면 async=true여도 동기 INSERT 경로로 폴백한다", async () => {
    /** 테스트 환경 기본값은 stub. 명시적으로 stub 보장. */
    const origStatus   = redisClient.status;
    redisClient.status = "stub";

    const mockClient = makeMockClient();
    const processor  = new BatchRememberProcessor({
      store  : {},
      index  : makeMockIndex(),
      factory: makeMockFactory(),
    });
    processor.setPool({ connect: mock.fn(async () => mockClient) });

    try {
      const result = await processor.process({
        async    : true,
        fragments: [validItem(0)]
      });

      /** 동기 경로 반환 구조: async 플래그 없음, inserted 존재 */
      assert.equal(result.async, undefined, "폴백 시 async 플래그가 있으면 안 됨");
      assert.equal(result.inserted, 1);
      assert.equal(result.skipped, 0);
      /** DB pool이 실제로 사용되었는지 확인 (동기 INSERT 경로 진입) */
      assert.ok(mockClient.query.mock.calls.length > 0, "동기 경로에서 DB 쿼리 실행됨");
    } finally {
      redisClient.status = origStatus;
    }
  });
});
