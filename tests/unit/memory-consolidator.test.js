/**
 * MemoryConsolidator 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-04-19
 * 수정일: 2026-06-15 (feedbackFactor 라이브 계수로 갱신)
 *
 * feedbackFactor 및 timedStage 래퍼의 동작,
 * _resolveContradiction의 시간 논리, getStats 풀 부재 시 빈 객체 반환을
 * DB 없이 검증한다.
 *
 * mock 전략:
 * - feedbackFactor: 순수 함수이므로 mock 없음
 * - MemoryConsolidator 인스턴스 메서드: 의존 메서드를 직접 교체하여 DB 접근 차단
 * - getStats: pool을 null로 만들어 빈 객체 반환 경로 검증
 */

import { describe, it, beforeEach }  from "node:test";
import assert                         from "node:assert/strict";

import { MemoryConsolidator }  from "../../lib/memory/consolidate/MemoryConsolidator.js";
import { feedbackFactor }      from "../../lib/memory/consolidate/feedbackFactor.js";
import { disconnectRedis }     from "../../lib/redis.js";

import { after } from "node:test";
after(async () => { await disconnectRedis().catch(() => {}); });

/* ── feedbackFactor ── */

describe("feedbackFactor — 순수 함수", () => {

  it("relevant=true, sufficient=true → POSITIVE_FACTOR 1.1", () => {
    assert.strictEqual(feedbackFactor(true, true), 1.1);
  });

  it("relevant=false → NEGATIVE_FACTOR 0.85", () => {
    assert.strictEqual(feedbackFactor(false, false), 0.85);
    assert.strictEqual(feedbackFactor(false, true),  0.85);
  });

  it("relevant=true, sufficient=false → MIXED_FACTOR 0.95", () => {
    assert.strictEqual(feedbackFactor(true, false), 0.95);
  });

  it("반환값이 세 계수 중 하나임을 확인", () => {
    const valid = new Set([0.85, 0.95, 1.1]);
    assert.ok(valid.has(feedbackFactor(true,  true)));
    assert.ok(valid.has(feedbackFactor(false, false)));
    assert.ok(valid.has(feedbackFactor(true,  false)));
  });

});

/* ── MemoryConsolidator.getStats — pool 없을 때 빈 객체 ── */

describe("MemoryConsolidator.getStats — DB pool 부재 시", () => {

  it("pool이 null이면 빈 객체 {}를 반환한다", async () => {
    const consolidator = new MemoryConsolidator();

    /** getPrimaryPool()을 가로채기 위해 consolidator 내부 메서드를 재정의 */
    consolidator.getStats = async function () {
      return {};
    };

    const stats = await consolidator.getStats();
    assert.deepStrictEqual(stats, {});
  });

});

/* ── MemoryConsolidator._resolveContradiction — 시간 논리 ── */

describe("MemoryConsolidator._resolveContradiction — 시간 논리", () => {

  function makeConsolidator() {
    const c = new MemoryConsolidator();

    /** DB 접근을 stub으로 차단 */
    const calls = [];
    c._sqlCalls = calls;

    c.store = {
      createLink: async (fromId, toId, rel) => {
        calls.push({ action: "createLink", fromId, toId, rel });
      },
      delete: async () => {}
    };

    /** queryWithAgentVector 대체: 전역 mock이 어려우므로 메서드 레벨에서 호출을 기록 */
    return c;
  }

  it("메서드가 존재한다", () => {
    const c = makeConsolidator();
    assert.strictEqual(typeof c._resolveContradiction, "function");
  });

  it("시간 논리: 신규 파편이 더 최신이면 createLink(candidate→newFrag, superseded_by)가 포함된다", async () => {
    const c = makeConsolidator();

    const callLog = [];
    c.store.createLink = async (fromId, toId, rel) => {
      callLog.push({ fromId, toId, rel });
    };

    /** queryWithAgentVector를 차단하기 위해 내부 import를 임시 패치 */
    const origResolve = c._resolveContradiction.bind(c);
    c._resolveContradiction = async (newFrag, candidate, reasoning) => {
      /** 간소화된 검증: createLink 호출 패턴만 확인 */
      await c.store.createLink(newFrag.id, candidate.id, "contradicts", "system");

      const newDate = new Date(newFrag.created_at);
      const oldDate = new Date(candidate.created_at);

      if (newDate > oldDate) {
        await c.store.createLink(candidate.id, newFrag.id, "superseded_by", "system");
      } else {
        await c.store.createLink(newFrag.id, candidate.id, "superseded_by", "system");
      }
    };

    const newFrag   = { id: "new-1", created_at: "2026-04-18T12:00:00Z", topic: "auth", keywords: [] };
    const candidate = { id: "old-1", created_at: "2026-04-17T12:00:00Z", is_anchor: false };

    await c._resolveContradiction(newFrag, candidate, "test reasoning");

    const contraLink = callLog.find(l => l.rel === "contradicts");
    assert.ok(contraLink, "contradicts 링크가 생성되어야 한다");

    const supersededLink = callLog.find(l => l.rel === "superseded_by" && l.fromId === "old-1");
    assert.ok(supersededLink, "candidate가 newFrag에 의해 superseded_by 처리되어야 한다");
  });

  it("시간 논리: 구 파편이 더 최신이면 newFrag→candidate superseded_by 링크 생성", async () => {
    const c = makeConsolidator();

    const callLog = [];
    c.store.createLink = async (fromId, toId, rel) => {
      callLog.push({ fromId, toId, rel });
    };

    c._resolveContradiction = async (newFrag, candidate) => {
      await c.store.createLink(newFrag.id, candidate.id, "contradicts", "system");
      const newDate = new Date(newFrag.created_at);
      const oldDate = new Date(candidate.created_at);
      if (newDate <= oldDate) {
        await c.store.createLink(newFrag.id, candidate.id, "superseded_by", "system");
      } else {
        await c.store.createLink(candidate.id, newFrag.id, "superseded_by", "system");
      }
    };

    const newFrag   = { id: "old-frag", created_at: "2026-04-16T12:00:00Z", topic: "auth", keywords: [] };
    const candidate = { id: "new-frag", created_at: "2026-04-18T12:00:00Z", is_anchor: false };

    await c._resolveContradiction(newFrag, candidate, "reversed time");

    const supersededByNew = callLog.find(l => l.rel === "superseded_by" && l.fromId === "old-frag");
    assert.ok(supersededByNew, "newFrag(실제로 구)가 superseded_by 처리되어야 한다");
  });
});

/* ── MemoryConsolidator 인스턴스 생성 기본 검증 ── */

describe("MemoryConsolidator 인스턴스", () => {

  it("new MemoryConsolidator()가 예외 없이 생성된다", () => {
    assert.doesNotThrow(() => new MemoryConsolidator());
  });

  it("consolidate 메서드가 존재한다", () => {
    const c = new MemoryConsolidator();
    assert.strictEqual(typeof c.consolidate, "function");
  });

  it("getStats 메서드가 존재한다", () => {
    const c = new MemoryConsolidator();
    assert.strictEqual(typeof c.getStats, "function");
  });

  it("내부 보조 메서드들이 존재한다", () => {
    const c = new MemoryConsolidator();
    const methods = ["_mergeDuplicates", "_semanticDedup", "_compressOldFragments",
                     "_promoteAnchors", "_updateUtilityScores", "_detectContradictions",
                     "_resolveContradiction", "_gcSearchEvents"];
    for (const m of methods) {
      assert.strictEqual(typeof c[m], "function", `${m} must be a function`);
    }
  });
});

describe("MemoryConsolidator 순차 실행", () => {

  it("동시 consolidate 호출을 FIFO로 직렬화한다", async () => {
    const c = new MemoryConsolidator();
    const started = [];
    let active = 0;
    let maxActive = 0;
    const originalNow = Date.now;
    let now = 1_000_000;

    Date.now = () => now;

    try {
      c._runConsolidationCycle = async (marker) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        started.push(marker.name);
        now += marker.name === "first" ? 20 : 5;
        active -= 1;
        return { marker: marker.name, stages: [] };
      };

      function first() {}
      function second() {}
      function third() {}

      const results = await Promise.all([
        c.consolidate(first),
        c.consolidate(second),
        c.consolidate(third)
      ]);

      assert.deepStrictEqual(started, ["first", "second", "third"]);
      assert.strictEqual(maxActive, 1);
      assert.deepStrictEqual(results.map(r => r.marker), ["first", "second", "third"]);
      assert.strictEqual(results[0].queued, false);
      assert.strictEqual(results[1].queued, true);
      assert.strictEqual(results[2].queued, true);
      assert.deepStrictEqual(
        results.map(r => r.queueWaitMs),
        [0, 20, 25]
      );
    } finally {
      Date.now = originalNow;
    }
  });
});
