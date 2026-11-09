/**
 * RecallSuggestionEngine 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-04-18
 *
 * 각 테스트는 독립된 엔진을 사용하여 상태 공유를 방지한다.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { RecallSuggestionEngine } from "../../lib/memory/read/RecallSuggestionEngine.js";

/** 같은 호출을 n번 보내고 마지막 응답을 돌려준다. */
async function suggestTimes(engine, params, result, n) {
  let last = null;
  for (let i = 0; i < n; i++) last = await engine.suggest(params, result);
  return last;
}

describe("RecallSuggestionEngine", { concurrency: false }, () => {

  /** ── 규칙 1: repeat_query ── */
  describe("repeat_query", () => {
    const empty = { fragments: [{ id: "frag-1" }] };

    it("같은 keywords를 5분 안에 3번 보내면 repeat_query 반환", async () => {
      const engine = new RecallSuggestionEngine();
      const params = { _keyId: "key-1", keywords: ["nginx", "ssl"] };

      const suggestion = await suggestTimes(engine, params, empty, 3);

      assert.strictEqual(suggestion?.code, "repeat_query");
      assert.ok(suggestion.message.includes("3회"), `message에 횟수 포함: ${suggestion.message}`);
      assert.strictEqual(suggestion.recommendedTool, "graph_explore");
    });

    it("fragments에 case_id 있으면 reconstruct_history 권유", async () => {
      const engine = new RecallSuggestionEngine();
      const params = { _keyId: "key-1", keywords: ["redis", "timeout"] };
      const result = {
        fragments: [
          { id: "frag-1", case_id: "debug-redis-2026-04-18" },
          { id: "frag-2", case_id: "debug-redis-2026-04-18" },
        ]
      };

      const suggestion = await suggestTimes(engine, params, result, 3);

      assert.strictEqual(suggestion?.code, "repeat_query");
      assert.strictEqual(suggestion.recommendedTool, "reconstruct_history");
      assert.strictEqual(suggestion.recommendedArgs.caseId, "debug-redis-2026-04-18");
    });

    it("2번까지는 null 반환", async () => {
      const engine = new RecallSuggestionEngine();
      assert.strictEqual(await suggestTimes(engine, { _keyId: "key-1", keywords: ["redis"] }, empty, 2), null);
    });

    it("keywords가 다르면 호출이 많아도 반복으로 보지 않는다", async () => {
      const engine = new RecallSuggestionEngine();
      for (const keyword of ["redis", "nginx", "postgres", "docker"]) {
        assert.strictEqual(await engine.suggest({ _keyId: "key-1", keywords: [keyword] }, empty), null);
      }
    });

    it("keywords가 같아도 text나 workspace가 다르면 반복으로 보지 않는다", async () => {
      const engine = new RecallSuggestionEngine();
      const base   = { _keyId: "key-1", keywords: ["memento-mcp"] };
      await engine.suggest({ ...base, text: "릴리스 절차" }, empty);
      await engine.suggest({ ...base, text: "배포 오류" }, empty);
      assert.strictEqual(await engine.suggest({ ...base, text: "배포 오류", workspace: "other" }, empty), null);
    });

    it("cursor로 다음 페이지를 읽는 호출은 세지 않는다", async () => {
      const engine = new RecallSuggestionEngine();
      const params = { _keyId: "key-1", keywords: ["redis"] };
      await engine.suggest(params, empty);
      await suggestTimes(engine, { ...params, cursor: "next" }, empty, 3);
      assert.strictEqual(await engine.suggest(params, empty), null);
    });

    it("keywords의 순서와 대소문자가 달라도 같은 질의로 센다", async () => {
      const engine = new RecallSuggestionEngine();
      await engine.suggest({ _keyId: "key-1", keywords: ["B", "a"] }, empty);
      await engine.suggest({ _keyId: "key-1", keywords: ["A", "b"] }, empty);
      const suggestion = await engine.suggest({ _keyId: "key-1", keywords: ["a", "B"] }, empty);
      assert.strictEqual(suggestion?.code, "repeat_query");
    });

    it("다른 키의 호출은 합치지 않는다", async () => {
      const engine = new RecallSuggestionEngine();
      await engine.suggest({ _keyId: "key-1", keywords: ["redis"] }, empty);
      await engine.suggest({ _keyId: "key-2", keywords: ["redis"] }, empty);
      assert.strictEqual(await engine.suggest({ _keyId: "key-3", keywords: ["redis"] }, empty), null);
    });

    it("5분이 지난 호출은 세지 않는다", async () => {
      let now = 0;
      const engine = new RecallSuggestionEngine({ now: () => now });
      const params = { _keyId: "key-1", keywords: ["redis"] };
      await suggestTimes(engine, params, empty, 2);
      now = 5 * 60 * 1000;
      assert.strictEqual(await engine.suggest(params, empty), null);
    });

    it("keywords 없으면 repeat_query 감지 안 함", async () => {
      const engine = new RecallSuggestionEngine();
      assert.strictEqual(await suggestTimes(engine, { _keyId: "key-1", text: "nginx 설정" }, empty, 3), null);
    });
  });

  /** ── 규칙 2: empty_result_no_context ── */
  describe("empty_result_no_context", () => {
    it("fragments 0개 + contextText 없음 + SpreadingActivation 켜짐 → empty_result_no_context 반환", async () => {
      /** search_events 빈 배열 → repeat_query 미매칭
       *  → fragments=0 && contextText 없음 → 매칭 */
      const engine = new RecallSuggestionEngine(); // 빈 events 배열

      const params = { _keyId: "key-1", keywords: ["nginx"] };
      const result = { fragments: [] };

      const saved = process.env.ENABLE_SPREADING_ACTIVATION;
      process.env.ENABLE_SPREADING_ACTIVATION = "true";
      let suggestion;
      try {
        suggestion = await engine.suggest(params, result);
      } finally {
        if (saved === undefined) delete process.env.ENABLE_SPREADING_ACTIVATION;
        else process.env.ENABLE_SPREADING_ACTIVATION = saved;
      }

      assert.ok(suggestion !== null);
      assert.strictEqual(suggestion.code, "empty_result_no_context");
      assert.strictEqual(suggestion.recommendedTool, "recall");
      assert.ok("contextText" in suggestion.recommendedArgs);
    });

    it("SpreadingActivation이 꺼져 있으면 효과 없는 contextText를 권하지 않는다", async () => {
      const engine = new RecallSuggestionEngine();
      const saved  = process.env.ENABLE_SPREADING_ACTIVATION;
      delete process.env.ENABLE_SPREADING_ACTIVATION;
      try {
        const suggestion = await engine.suggest({ _keyId: "key-1", keywords: ["nginx"] }, { fragments: [] });
        assert.strictEqual(suggestion, null);
      } finally {
        if (saved !== undefined) process.env.ENABLE_SPREADING_ACTIVATION = saved;
      }
    });

    it("contextText 있으면 empty_result_no_context 아님", async () => {
      /** fragments=0 이지만 contextText 있음 → empty_result_no_context 스킵
       *  → large_limit_no_budget 아님 */
      const engine = new RecallSuggestionEngine();

      const params = { _keyId: "key-1", keywords: [], contextText: "현재 nginx 디버깅 중" };
      const result = { fragments: [] };

      const suggestion = await engine.suggest(params, result);
      assert.strictEqual(suggestion, null);
    });
  });

  /** ── 규칙 3: large_limit_no_budget ── */
  describe("page_cut_by_budget", () => {
    const cut = { fragments: [{ id: "frag-a" }], nextCursor: "next", _budgetCut: { requested: 50, returned: 16, budget: 1000 } };

    it("건수를 지정했고 예산 때문에 덜 돌아오면 이어 읽을 커서를 안내한다", async () => {
      const suggestion = await new RecallSuggestionEngine().suggest({ _keyId: "key-1", pageSize: 50 }, cut);
      assert.strictEqual(suggestion?.code, "page_cut_by_budget");
      assert.ok(suggestion.message.includes("16건"));
      assert.deepStrictEqual(suggestion.recommendedArgs, { cursor: "next" });
    });

    it("예산 때문이 아니면 안내하지 않는다", async () => {
      const result = { fragments: [{ id: "frag-a" }], nextCursor: "next", _budgetCut: null };
      assert.strictEqual(await new RecallSuggestionEngine().suggest({ _keyId: "key-1", pageSize: 50 }, result), null);
    });

    it("건수를 지정하지 않았거나 예산을 지정했으면 안내하지 않는다", async () => {
      const engine = new RecallSuggestionEngine();
      assert.strictEqual(await engine.suggest({ _keyId: "key-1" }, cut), null);
      assert.strictEqual(await engine.suggest({ _keyId: "key-2", pageSize: 50, tokenBudget: 800 }, cut), null);
    });
  });

  /** ── 우선순위 검증 ── */
  describe("우선순위", () => {
    it("repeat_query와 empty_result_no_context 동시 해당 → repeat_query 반환", async () => {
      /** fragments=0 (empty_result_no_context 해당) + events 3개(repeat_query 해당)
       *  → 더 높은 우선순위인 repeat_query가 반환됨 */
      const engine = new RecallSuggestionEngine();

      const params = { _keyId: "key-1", keywords: ["redis"] };
      const result = { fragments: [] };

      const suggestion = await suggestTimes(engine, params, result, 3);

      assert.ok(suggestion !== null);
      assert.strictEqual(suggestion.code, "repeat_query");
    });
  });
});
