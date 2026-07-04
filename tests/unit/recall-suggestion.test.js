/**
 * RecallSuggestionEngine 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-04-18
 *
 * 각 테스트는 독립된 pool mock을 사용하여 상태 공유를 방지한다.
 * pool.query 호출 순서대로 responses 배열에서 결과를 꺼낸다.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

/**
 * 테스트는 createEngine()에서 pool을 직접 주입하므로 getPrimaryPool fallback은 호출되지 않는다.
 * logWarn은 실제 호출되어도 테스트 판정에 영향 없으므로 자연 import 그대로 사용한다.
 */
import { RecallSuggestionEngine } from "../../lib/memory/read/RecallSuggestionEngine.js";

/**
 * 응답 배열을 순서대로 반환하는 pool mock과 엔진을 생성한다.
 *
 * responses 요소 형태:
 *  - Array  → { rows: Array } 반환 (search_events 또는 fragment count 결과)
 *  - Error  → reject
 *
 * @param {Array<Array|Error>} responses
 * @returns {RecallSuggestionEngine}
 */
function createEngine(responses = []) {
  let idx = 0;
  const pool = {
    query: async () => {
      const resp = responses[idx++];
      if (resp instanceof Error) throw resp;
      return { rows: Array.isArray(resp) ? resp : [] };
    }
  };
  return new RecallSuggestionEngine({ pool });
}

/** ─────────────────────── search_events 행 헬퍼 ─────────────────────── */
function eventsOf(n, type = "keywords") {
  return Array.from({ length: n }, () => ({ query_type: type, filter_keys: [], result_count: 2 }));
}

function countRow(cnt) {
  return [{ cnt }];
}

describe("RecallSuggestionEngine", { concurrency: false }, () => {

  /** ── 규칙 1: repeat_query ── */
  describe("repeat_query", () => {
    it("5분 내 keywords 쿼리 3회 이상 → repeat_query 반환", async () => {
      const engine = createEngine([eventsOf(3)]);

      const params = { _keyId: "key-1", keywords: ["nginx", "ssl"] };
      const result = { fragments: [] };

      const suggestion = await engine.suggest(params, result);

      assert.ok(suggestion !== null, "suggestion이 null이면 안 됨");
      assert.strictEqual(suggestion.code, "repeat_query");
      assert.ok(suggestion.message.includes("3회"), `message에 횟수 포함: ${suggestion.message}`);
      assert.strictEqual(suggestion.recommendedTool, "graph_explore");
    });

    it("fragments에 case_id 있으면 reconstruct_history 권유", async () => {
      const engine = createEngine([eventsOf(3)]);

      const params = { _keyId: "key-1", keywords: ["redis", "timeout"] };
      const result = {
        fragments: [
          { id: "frag-1", case_id: "debug-redis-2026-04-18" },
          { id: "frag-2", case_id: "debug-redis-2026-04-18" },
        ]
      };

      const suggestion = await engine.suggest(params, result);

      assert.ok(suggestion !== null);
      assert.strictEqual(suggestion.code, "repeat_query");
      assert.strictEqual(suggestion.recommendedTool, "reconstruct_history");
      assert.strictEqual(suggestion.recommendedArgs.caseId, "debug-redis-2026-04-18");
    });

    it("2회 반복이면 null 반환 (3회 미만)", async () => {
      /** search_events 2개 → repeat_query 미매칭
       *  → empty_result_no_context 아님(fragments 있음)
       *  → large_limit_no_budget 아님(limit 없음)
       *  → no_type_filter_noisy: count 조회 → 10개 → 미매칭 */
      const engine = createEngine([eventsOf(2), countRow(10)]);

      const params = { _keyId: "key-1", keywords: ["redis"] };
      const result = { fragments: [{ id: "frag-1" }] };

      const suggestion = await engine.suggest(params, result);
      assert.strictEqual(suggestion, null);
    });

    it("keywords 없으면 repeat_query 감지 안 함 (normTarget 빈 문자열)", async () => {
      /** search_events 반환되지만 keywords 없으면 normTarget="" → 감지 스킵
       *  → empty_result_no_context 아님(fragments 있음)
       *  → no_type_filter_noisy: count 5개 → 미매칭 */
      const engine = createEngine([eventsOf(3, "text"), countRow(5)]);

      const params = { _keyId: "key-1", text: "nginx 설정" };
      const result = { fragments: [{ id: "frag-x" }] };

      const suggestion = await engine.suggest(params, result);
      assert.strictEqual(suggestion, null);
    });
  });

  /** ── 규칙 2: empty_result_no_context ── */
  describe("empty_result_no_context", () => {
    it("fragments 0개 + contextText 없음 → empty_result_no_context 반환", async () => {
      /** search_events 빈 배열 → repeat_query 미매칭
       *  → fragments=0 && contextText 없음 → 매칭 */
      const engine = createEngine([[]]); // 빈 events 배열

      const params = { _keyId: "key-1", keywords: ["nginx"] };
      const result = { fragments: [] };

      const suggestion = await engine.suggest(params, result);

      assert.ok(suggestion !== null);
      assert.strictEqual(suggestion.code, "empty_result_no_context");
      assert.strictEqual(suggestion.recommendedTool, "recall");
      assert.ok("contextText" in suggestion.recommendedArgs);
    });

    it("contextText 있으면 empty_result_no_context 아님", async () => {
      /** fragments=0 이지만 contextText 있음 → empty_result_no_context 스킵
       *  → large_limit_no_budget 아님 → no_type_filter_noisy: count 5개 → 미매칭 */
      const engine = createEngine([[], countRow(5)]);

      const params = { _keyId: "key-1", keywords: [], contextText: "현재 nginx 디버깅 중" };
      const result = { fragments: [] };

      const suggestion = await engine.suggest(params, result);
      assert.strictEqual(suggestion, null);
    });
  });

  /** ── 규칙 3: large_limit_no_budget ── */
  describe("large_limit_no_budget", () => {
    it("limit >= 50 && tokenBudget 없음 → large_limit_no_budget 반환", async () => {
      const engine = createEngine([[]]); // 빈 events

      const params = { _keyId: "key-1", keywords: ["test"], limit: 50 };
      const result = { fragments: [{ id: "frag-a" }] };

      const suggestion = await engine.suggest(params, result);

      assert.ok(suggestion !== null);
      assert.strictEqual(suggestion.code, "large_limit_no_budget");
      assert.strictEqual(suggestion.recommendedTool, "recall");
      assert.strictEqual(suggestion.recommendedArgs.tokenBudget, 2000);
    });

    it("limit < 50이면 large_limit_no_budget 아님", async () => {
      const engine = createEngine([[], countRow(10)]);

      const params = { _keyId: "key-1", keywords: ["test"], limit: 20 };
      const result = { fragments: [{ id: "frag-a" }] };

      const suggestion = await engine.suggest(params, result);
      assert.strictEqual(suggestion, null);
    });

    it("tokenBudget 있으면 large_limit_no_budget 아님", async () => {
      const engine = createEngine([[], countRow(10)]);

      const params = { _keyId: "key-1", keywords: [], limit: 100, tokenBudget: 2000 };
      const result = { fragments: [{ id: "frag-a" }] };

      const suggestion = await engine.suggest(params, result);
      assert.strictEqual(suggestion, null);
    });
  });

  /** ── 규칙 4: no_type_filter_noisy ── */
  describe("no_type_filter_noisy", () => {
    it("type 미지정 + 파편 > 100 → no_type_filter_noisy 반환", async () => {
      /** events 빈 배열 → repeat_query 미매칭
       *  → fragments 있음 → empty_result_no_context 스킵
       *  → limit 없음 → large_limit_no_budget 스킵
       *  → type 없음 → count 150 → 매칭 */
      const engine = createEngine([[], countRow(150)]);

      const params = { _keyId: "key-1", keywords: ["test"] };
      const result = { fragments: [{ id: "frag-z" }] };

      const suggestion = await engine.suggest(params, result);

      assert.ok(suggestion !== null);
      assert.strictEqual(suggestion.code, "no_type_filter_noisy");
      assert.ok(suggestion.message.includes("150"));
      assert.strictEqual(suggestion.recommendedTool, "recall");
    });

    it("파편 <= 100이면 no_type_filter_noisy 아님", async () => {
      const engine = createEngine([[], countRow(80)]);

      const params = { _keyId: "key-1" };
      const result = { fragments: [{ id: "frag-z" }] };

      const suggestion = await engine.suggest(params, result);
      assert.strictEqual(suggestion, null);
    });

    it("type 지정되면 no_type_filter_noisy 건너뜀 (count 쿼리 미실행)", async () => {
      /** type 있으면 규칙 4 완전 스킵 → query 호출 1회(events)만 */
      let queryCalls = 0;
      const pool = {
        query: async () => {
          queryCalls++;
          return { rows: [] };
        }
      };
      const engine = new RecallSuggestionEngine({ pool });

      const params = { _keyId: "key-1", type: "error" };
      const result = { fragments: [{ id: "frag-z" }] };

      const suggestion = await engine.suggest(params, result);
      assert.strictEqual(suggestion, null);
      assert.strictEqual(queryCalls, 1, "search_events 쿼리만 호출됨");
    });
  });

  /** ── 우선순위 검증 ── */
  describe("우선순위", () => {
    it("repeat_query와 empty_result_no_context 동시 해당 → repeat_query 반환", async () => {
      /** fragments=0 (empty_result_no_context 해당) + events 3개(repeat_query 해당)
       *  → 더 높은 우선순위인 repeat_query가 반환됨 */
      const engine = createEngine([eventsOf(3)]);

      const params = { _keyId: "key-1", keywords: ["redis"] };
      const result = { fragments: [] };

      const suggestion = await engine.suggest(params, result);

      assert.ok(suggestion !== null);
      assert.strictEqual(suggestion.code, "repeat_query");
    });

    it("large_limit_no_budget와 no_type_filter_noisy 동시 해당 → large_limit_no_budget 반환", async () => {
      /** limit=50 tokenBudget 없음(large_limit_no_budget 해당)
       *  type 없음 + count>100이어도 large_limit_no_budget이 먼저 매칭 */
      const engine = createEngine([[]]); // events만 — count 쿼리 미도달

      const params = { _keyId: "key-1", keywords: [], limit: 50 };
      const result = { fragments: [{ id: "frag-a" }] };

      const suggestion = await engine.suggest(params, result);

      assert.ok(suggestion !== null);
      assert.strictEqual(suggestion.code, "large_limit_no_budget");
    });
  });

  /** ── fail-open 검증 ── */
  describe("fail-open", () => {
    it("repeat_query DB 실패 시 다음 규칙으로 폴백 (throw 안 함)", async () => {
      /** search_events 쿼리 실패 → repeat_query catch → 스킵
       *  → fragments=0 && contextText 없음 → empty_result_no_context 반환 */
      const engine = createEngine([new Error("connection refused")]);

      const params = { _keyId: "key-1", keywords: ["nginx"] };
      const result = { fragments: [] };

      const suggestion = await engine.suggest(params, result);

      assert.ok(
        suggestion === null || suggestion.code === "empty_result_no_context",
        `예상치 못한 code: ${suggestion?.code}`
      );
    });

    it("fragment count DB 실패 시 no_type_filter_noisy null 반환", async () => {
      /** search_events 정상, count 쿼리 실패 → no_type_filter_noisy catch → null */
      const engine = createEngine([[], new Error("timeout")]);

      const params = { _keyId: "key-1", keywords: [], limit: 10 };
      const result = { fragments: [{ id: "frag-a" }] };

      const suggestion = await engine.suggest(params, result);
      assert.strictEqual(suggestion, null);
    });
  });
});
