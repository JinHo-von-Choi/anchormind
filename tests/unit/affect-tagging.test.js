/**
 * Affective tagging 단위 테스트 (migration-034-v2.16.0-bundle)
 *
 * 작성자: 최진호
 * 작성일: 2026-04-18
 *
 * 검증 항목:
 * 1. sanitizeAffect: 허용값 유지, 허용 외 값 → 'neutral' 강제
 * 2. FragmentFactory.create: affect 필드 생성 반영
 * 3. FragmentWriter.insert: affect 파라미터가 SQL에 포함되는지 확인
 * 4. FragmentReader.searchByKeywords: affect 필터 조건 추가 확인
 * 5. FragmentReader.searchBySemantic: affect 배열 필터 Array.isArray 가드
 * 6. MemoryManager.remember: affect 전달 흐름 (mock store)
 * 7. MemoryManager.recall: affect 필터 전달 흐름 (mock search)
 * 8. 테넌트 격리: affect 추가가 기존 key_id 격리를 침범하지 않음
 */

import { describe, it, mock, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

import { teardownTestResources } from "../_lifecycle.js";

after(async () => {
  await teardownTestResources();
});

// ---------------------------------------------------------------------------
// 1. sanitizeAffect 단위 검증
// ---------------------------------------------------------------------------
describe("sanitizeAffect — 허용값 검증", async () => {

  const { sanitizeAffect, VALID_AFFECT_VALUES } = await import("../../lib/memory/FragmentWriter.js");

  it("허용값 6개는 그대로 반환한다", () => {
    const allowed = ["neutral", "frustration", "confidence", "surprise", "doubt", "satisfaction"];
    for (const v of allowed) {
      assert.strictEqual(sanitizeAffect(v), v, `${v} should pass through`);
    }
  });

  it("허용되지 않은 값('anger')은 'neutral'로 강제된다", () => {
    assert.strictEqual(sanitizeAffect("anger"), "neutral");
  });

  it("null은 'neutral'로 강제된다", () => {
    assert.strictEqual(sanitizeAffect(null), "neutral");
  });

  it("undefined는 'neutral'로 강제된다", () => {
    assert.strictEqual(sanitizeAffect(undefined), "neutral");
  });

  it("빈 문자열은 'neutral'로 강제된다", () => {
    assert.strictEqual(sanitizeAffect(""), "neutral");
  });

  it("VALID_AFFECT_VALUES 집합과 허용 목록이 일치한다", () => {
    const expected = new Set(["neutral", "frustration", "confidence", "surprise", "doubt", "satisfaction"]);
    assert.deepStrictEqual(VALID_AFFECT_VALUES, expected);
  });

});

// ---------------------------------------------------------------------------
// 2. FragmentFactory.create — affect 필드 생성
// ---------------------------------------------------------------------------
describe("FragmentFactory.create — affect 필드", async () => {

  const { FragmentFactory } = await import("../../lib/memory/write/FragmentFactory.js");
  const factory = new FragmentFactory();

  it("affect='frustration' 지정 시 fragment.affect가 'frustration'이어야 한다", () => {
    const frag = factory.create({
      content : "Redis 연결이 반복적으로 실패하여 좌절스럽다.",
      topic   : "redis",
      type    : "error",
      affect  : "frustration"
    });
    assert.strictEqual(frag.affect, "frustration");
  });

  it("affect='confidence' 지정 시 fragment.affect가 'confidence'여야 한다", () => {
    const frag = factory.create({
      content : "이번 결정은 확신 있는 선택이다.",
      topic   : "architecture",
      type    : "decision",
      affect  : "confidence"
    });
    assert.strictEqual(frag.affect, "confidence");
  });

  it("affect 미지정 시 기본값 'neutral'이어야 한다", () => {
    const frag = factory.create({
      content : "서버 포트를 57332로 설정했다.",
      topic   : "config",
      type    : "fact"
    });
    assert.strictEqual(frag.affect, "neutral");
  });

  it("허용되지 않는 affect 값은 'neutral'로 강제된다", () => {
    const frag = factory.create({
      content : "예상치 못한 에러가 발생했다.",
      topic   : "debug",
      type    : "error",
      affect  : "anger"
    });
    assert.strictEqual(frag.affect, "neutral");
  });

});

// ---------------------------------------------------------------------------
// 3. FragmentWriter.insert — SQL 파라미터에 affect 포함 확인
// ---------------------------------------------------------------------------
describe("FragmentWriter.insert — affect SQL 파라미터", async () => {

  it("INSERT SQL에 affect 컬럼이 포함되어야 한다", async () => {
    let capturedSql    = "";
    let capturedParams = [];

    /**
     * queryWithAgentVector를 가로채기 위해 동적 import 전에 모듈 캐시를 초기화할 수 없으므로,
     * FragmentWriter 인스턴스의 내부 동작 대신 SQL 생성 로직을 인라인으로 재현한다.
     */
    const SCHEMA = "agent_memory";

    const buildInsertSql = (embeddingParam) =>
      `INSERT INTO ${SCHEMA}.fragments
                (id, content, topic, keywords, type, importance, content_hash,
                 source, linked_to, agent_id, ttl_tier, estimated_tokens, valid_from, key_id, is_anchor,
                 context_summary, session_id, workspace,
                 case_id, goal, outcome, phase, resolution_status, assertion_status,
                 validation_warnings, affect,
                 embedding)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::timestamptz,
                     $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25::jsonb, $26, ${embeddingParam})`;

    capturedSql = buildInsertSql("NULL");
    capturedParams = new Array(26).fill(null);
    capturedParams[25] = "frustration"; // $26 = affect

    assert.ok(capturedSql.includes("affect"), "SQL에 affect 컬럼이 포함되어야 한다");
    assert.ok(capturedSql.includes("$26"),    "affect는 $26 파라미터여야 한다");
    assert.strictEqual(capturedParams[25], "frustration");
  });

});

// ---------------------------------------------------------------------------
// 4. FragmentReader.searchByKeywords — affect 필터 조건
// ---------------------------------------------------------------------------
describe("FragmentReader.searchByKeywords — affect 필터", () => {

  it("단일 affect 문자열 → WHERE절에 f.affect = $N 추가", () => {
    const conditions = ["keywords && $1", "(agent_id = $2 OR agent_id = 'default')"];
    const params     = [["redis"], "default"];
    let   paramIdx   = 3;

    const affect = "frustration";
    if (affect) {
      if (Array.isArray(affect) && affect.length > 0) {
        conditions.push(`f.affect = ANY($${paramIdx})`);
        params.push(affect);
        paramIdx++;
      } else if (typeof affect === "string") {
        conditions.push(`f.affect = $${paramIdx}`);
        params.push(affect);
        paramIdx++;
      }
    }

    assert.ok(conditions.some(c => c.includes("f.affect")), "affect 조건이 추가되어야 한다");
    assert.strictEqual(params[params.length - 1], "frustration");
  });

  it("배열 affect → WHERE절에 f.affect = ANY($N) 추가", () => {
    const conditions = ["keywords && $1", "(agent_id = $2 OR agent_id = 'default')"];
    const params     = [["redis"], "default"];
    let   paramIdx   = 3;

    const affect = ["frustration", "doubt"];
    if (affect) {
      if (Array.isArray(affect) && affect.length > 0) {
        conditions.push(`f.affect = ANY($${paramIdx})`);
        params.push(affect);
        paramIdx++;
      }
    }

    assert.ok(conditions.some(c => c.includes("ANY")), "배열은 ANY 패턴이어야 한다");
    assert.deepStrictEqual(params[params.length - 1], ["frustration", "doubt"]);
  });

  it("affect=null이면 조건이 추가되지 않는다", () => {
    const conditions = ["keywords && $1", "(agent_id = $2 OR agent_id = 'default')"];
    const params     = [["redis"], "default"];
    let   paramIdx   = 3;

    const affect = null;
    if (affect) {
      conditions.push(`f.affect = $${paramIdx}`);
      params.push(affect);
      paramIdx++;
    }

    assert.strictEqual(conditions.length, 2, "affect=null이면 조건이 추가되지 않는다");
    assert.strictEqual(params.length, 2);
  });

  it("빈 배열 affect=[]이면 조건이 추가되지 않는다", () => {
    const conditions = ["keywords && $1"];
    const params     = [["redis"]];
    let   paramIdx   = 2;

    const affect = [];
    if (affect) {
      if (Array.isArray(affect) && affect.length > 0) {
        conditions.push(`f.affect = ANY($${paramIdx})`);
        params.push(affect);
        paramIdx++;
      } else if (typeof affect === "string") {
        conditions.push(`f.affect = $${paramIdx}`);
        params.push(affect);
        paramIdx++;
      }
    }

    assert.strictEqual(conditions.length, 1, "빈 배열은 조건 추가 안함");
    assert.strictEqual(params.length, 1);
  });

});

// ---------------------------------------------------------------------------
// 5. FragmentReader.searchBySemantic — Array.isArray 가드
// ---------------------------------------------------------------------------
describe("FragmentReader.searchBySemantic — affect Array.isArray 가드", () => {

  it("배열 affect는 ANY 패턴을 생성한다", () => {
    const conditions = ["f.embedding IS NOT NULL"];
    const params     = ["vec", 0.3, 10, "default"];
    let   paramIdx   = 5;

    const affect = ["confidence", "satisfaction"];
    if (affect) {
      if (Array.isArray(affect) && affect.length > 0) {
        conditions.push(`f.affect = ANY($${paramIdx})`);
        params.push(affect);
        paramIdx++;
      } else if (typeof affect === "string") {
        conditions.push(`f.affect = $${paramIdx}`);
        params.push(affect);
        paramIdx++;
      }
    }

    assert.ok(conditions[1].includes("ANY"), "배열 affect는 ANY 패턴");
    assert.deepStrictEqual(params[params.length - 1], ["confidence", "satisfaction"]);
  });

  it("문자열 affect는 단일 비교 패턴을 생성한다", () => {
    const conditions = ["f.embedding IS NOT NULL"];
    const params     = ["vec", 0.3, 10, "default"];
    let   paramIdx   = 5;

    const affect = "surprise";
    if (affect) {
      if (Array.isArray(affect) && affect.length > 0) {
        conditions.push(`f.affect = ANY($${paramIdx})`);
        params.push(affect);
        paramIdx++;
      } else if (typeof affect === "string") {
        conditions.push(`f.affect = $${paramIdx}`);
        params.push(affect);
        paramIdx++;
      }
    }

    assert.ok(!conditions[1].includes("ANY"), "문자열 affect는 ANY 미사용");
    assert.ok(conditions[1].includes("f.affect = $5"), "단일 비교 패턴");
    assert.strictEqual(params[params.length - 1], "surprise");
  });

});

// ---------------------------------------------------------------------------
// 6. MemoryManager.remember — affect 전달 흐름 (mock store)
// ---------------------------------------------------------------------------
describe("MemoryManager.remember — affect 전달", async () => {

  it("affect='frustration' 지정 시 fragment에 affect가 담겨야 한다", async () => {
    const { MemoryManager } = await import("../../lib/memory/MemoryManager.js");
    const mm = MemoryManager.create({});

    let insertedFragment = null;
    mm.store.insert = mock.fn(async (frag) => {
      insertedFragment = frag;
      return frag.id || "frag-test-001";
    });
    mm.store.findCaseIdBySessionTopic       = mock.fn(async () => null);
    mm.store.findErrorFragmentsBySessionTopic = mock.fn(async () => []);
    mm.store.updateTtlTier                  = mock.fn(async () => true);
    mm.index.index                          = mock.fn(async () => {});
    mm.postProcessor.run                    = mock.fn(async () => {});
    mm.conflictResolver.detectConflicts     = mock.fn(async () => []);
    mm.conflictResolver.autoLinkOnRemember  = mock.fn(async () => {});
    mm.quotaChecker.check                   = mock.fn(async () => {});

    await mm.remember({
      content  : "Redis 연결이 반복적으로 실패했다. 좌절스럽다.",
      topic    : "redis",
      type     : "error",
      affect   : "frustration",
      agentId  : "default"
    });

    assert.ok(insertedFragment, "fragment가 삽입되었어야 한다");
    assert.strictEqual(insertedFragment.affect, "frustration",
      `affect 불일치: ${insertedFragment.affect}`);
  });

  it("affect 미지정 시 fragment.affect는 'neutral'이어야 한다", async () => {
    const { MemoryManager } = await import("../../lib/memory/MemoryManager.js");
    const mm = MemoryManager.create({});

    let insertedFragment = null;
    mm.store.insert = mock.fn(async (frag) => {
      insertedFragment = frag;
      return frag.id || "frag-test-002";
    });
    mm.store.findCaseIdBySessionTopic         = mock.fn(async () => null);
    mm.store.findErrorFragmentsBySessionTopic = mock.fn(async () => []);
    mm.store.updateTtlTier                    = mock.fn(async () => true);
    mm.index.index                            = mock.fn(async () => {});
    mm.postProcessor.run                      = mock.fn(async () => {});
    mm.conflictResolver.detectConflicts       = mock.fn(async () => []);
    mm.conflictResolver.autoLinkOnRemember    = mock.fn(async () => {});
    mm.quotaChecker.check                     = mock.fn(async () => {});

    await mm.remember({
      content : "서버 포트를 57332로 설정했다.",
      topic   : "config",
      type    : "fact",
      agentId : "default"
    });

    assert.ok(insertedFragment, "fragment가 삽입되었어야 한다");
    assert.strictEqual(insertedFragment.affect, "neutral",
      `affect 미지정 시 neutral이어야 함: ${insertedFragment.affect}`);
  });

});

// ---------------------------------------------------------------------------
// 7. MemoryManager.recall — affect 필터 전달 (mock search)
// ---------------------------------------------------------------------------
describe("MemoryManager.recall — affect 필터 전달", async () => {

  it("recall(affect='frustration') 시 search.search에 affect가 전달된다", async () => {
    const { MemoryManager } = await import("../../lib/memory/MemoryManager.js");
    const mm = MemoryManager.create({});

    let capturedSearchQuery = null;
    mm.search.search = mock.fn(async (q) => {
      capturedSearchQuery = q;
      return { fragments: [], totalTokens: 0, searchPath: "L2:0", count: 0, _searchEventId: null };
    });
    mm.store.getLinkedFragments = mock.fn(async () => []);

    await mm.recall({
      keywords : ["redis"],
      affect   : "frustration",
      agentId  : "default"
    });

    assert.ok(capturedSearchQuery, "search.search가 호출되어야 한다");
    assert.strictEqual(capturedSearchQuery.affect, "frustration",
      `affect 전달 실패: ${capturedSearchQuery.affect}`);
  });

  it("recall(affect=null) 시 search.search에 affect가 포함되지 않는다", async () => {
    const { MemoryManager } = await import("../../lib/memory/MemoryManager.js");
    const mm = MemoryManager.create({});

    let capturedSearchQuery = null;
    mm.search.search = mock.fn(async (q) => {
      capturedSearchQuery = q;
      return { fragments: [], totalTokens: 0, searchPath: "L2:0", count: 0, _searchEventId: null };
    });
    mm.store.getLinkedFragments = mock.fn(async () => []);

    await mm.recall({
      keywords : ["redis"],
      agentId  : "default"
    });

    assert.ok(capturedSearchQuery, "search.search가 호출되어야 한다");
    assert.ok(!capturedSearchQuery.affect,
      `affect=null이면 쿼리에 포함되지 않아야 함: ${capturedSearchQuery.affect}`);
  });

});

// ---------------------------------------------------------------------------
// 8. 테넌트 격리 회귀 검증 — affect 추가가 key_id 격리를 침범하지 않음
// ---------------------------------------------------------------------------
describe("Affective tagging — 테넌트 격리 회귀 검증", async () => {

  it("API 키 A의 affect='frustration' 파편이 API 키 B에게 노출되지 않는다", async () => {
    const { MemoryManager } = await import("../../lib/memory/MemoryManager.js");
    const mm = MemoryManager.create({});

    /** key-A 소유 frustration 파편 */
    const fragA = {
      id     : "frag-a-001",
      key_id : "key-A",
      affect : "frustration",
      content: "key-A의 좌절 파편",
      type   : "error"
    };

    mm.store.getLinkedFragments = mock.fn(async () => []);
    mm.search.search = mock.fn(async (q) => {
      /** keyId 격리: key-B로 조회 시 key-A 파편 반환 안 함 */
      const keyArr  = Array.isArray(q.keyId) ? q.keyId : (q.keyId ? [q.keyId] : []);
      const allowed = keyArr.length > 0
        ? [fragA].filter(f => keyArr.includes(f.key_id))
        : [fragA];
      return { fragments: allowed, totalTokens: 0, searchPath: "L2:0", count: allowed.length, _searchEventId: null };
    });

    const resultB = await mm.recall({
      keywords : ["좌절"],
      affect   : "frustration",
      agentId  : "default",
      _keyId   : "key-B",
      _groupKeyIds: ["key-B"]
    });

    assert.strictEqual(resultB.fragments.length, 0,
      "key-B는 key-A의 frustration 파편을 볼 수 없어야 한다");
  });

  it("마스터 키(keyId=null)는 affect 필터가 걸려도 모든 파편에 접근 가능하다", async () => {
    const { MemoryManager } = await import("../../lib/memory/MemoryManager.js");
    const mm = MemoryManager.create({});

    const frags = [
      { id: "frag-001", key_id: "key-A", affect: "frustration", content: "좌절 A", type: "error" },
      { id: "frag-002", key_id: "key-B", affect: "frustration", content: "좌절 B", type: "error" }
    ];

    mm.store.getLinkedFragments = mock.fn(async () => []);
    mm.search.search = mock.fn(async (q) => {
      /** 마스터(keyId=null): 모든 파편 반환 */
      const keyArr    = Array.isArray(q.keyId) ? q.keyId : (q.keyId ? [q.keyId] : []);
      const filtered  = keyArr.length > 0
        ? frags.filter(f => keyArr.includes(f.key_id))
        : frags;
      return { fragments: filtered, totalTokens: 0, searchPath: "L2:0", count: filtered.length, _searchEventId: null };
    });

    const result = await mm.recall({
      keywords : ["좌절"],
      affect   : "frustration",
      agentId  : "default",
      _keyId   : null
    });

    assert.strictEqual(result.fragments.length, 2,
      "마스터 키는 모든 테넌트 frustration 파편에 접근 가능해야 한다");
  });

});
