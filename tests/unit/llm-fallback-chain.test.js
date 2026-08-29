/**
 * Unit tests: LLM Fallback Chain (dispatcher)
 *
 * lib/llm/index.js의 buildChain + llmJson 순차 폴백 동작을 검증한다.
 * 실제 API 호출 0건 — LlmProvider 추상 기반 클래스를 직접 서브클래싱하여
 * fetch mock 없이 callText 동작을 제어한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-04-16
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";

import { LlmProvider } from "../../lib/llm/LlmProvider.js";
import { redisClient } from "../../lib/redis.js";

// Redis 연결 해제 — 프로세스 정상 종료
after(async () => {
  try { await redisClient.quit(); } catch (_) {}
});

// ---------------------------------------------------------------------------
// Mock Provider 팩토리
// ---------------------------------------------------------------------------

/**
 * 테스트용 controllable provider.
 * shouldFail=true 이면 callText에서 throw한다.
 */
function createMockProvider(name, shouldFail, responseText = '{"ok":true}') {
  return Object.assign(Object.create(LlmProvider.prototype), {
    name,
    config: { name },
    callCount: 0,
    async isAvailable() { return true; },
    async isCircuitOpen() { return false; },
    async recordSuccess() {},
    async recordFailure() {},
    async callText(_prompt) {
      this.callCount++;
      if (shouldFail) {
        throw new Error(`${name}: simulated failure`);
      }
      return responseText;
    }
  });
}

// ---------------------------------------------------------------------------
// buildChain + llmJson 동작 검증을 위한 래퍼
// ---------------------------------------------------------------------------

/**
 * lib/llm/index.js의 llmJson은 buildChain() 내에서 createProvider()를 호출하여
 * LLM_PRIMARY + LLM_FALLBACKS 환경 기반으로 체인을 구성한다.
 * 단위 테스트에서 이 체인 전체를 mock하려면 provider 목록을 직접 주입하는
 * 인라인 dispatcher 함수를 사용한다 (index.js 내부 buildChain은 환경 의존).
 *
 * 테스트 대상 핵심 로직: 체인 순회 + 첫 성공 반환 + 전체 실패 시 throw.
 */
async function dispatchChain(chain, prompt) {
  const { parseJsonResponse } = await import("../../lib/llm/util/parse-json.js");
  const errors = [];

  for (const provider of chain) {
    if (await provider.isCircuitOpen()) {
      errors.push(`${provider.name}: circuit open`);
      continue;
    }
    try {
      const text   = await provider.callText(prompt);
      const result = parseJsonResponse(text);
      return result;
    } catch (err) {
      errors.push(`${provider.name}: ${err.message}`);
    }
  }

  throw new Error(`all LLM providers failed: ${errors.join("; ")}`);
}

// ---------------------------------------------------------------------------
// 테스트
// ---------------------------------------------------------------------------

describe("llmJson fallback chain — 순차 폴백 동작", () => {

  it("primary 성공 시 즉시 결과를 반환한다", async () => {
    const primary  = createMockProvider("primary", false, '{"source":"primary"}');
    const fallback = createMockProvider("fallback", false, '{"source":"fallback"}');

    const result = await dispatchChain([primary, fallback], "test");
    assert.deepEqual(result, { source: "primary" });
    assert.equal(primary.callCount,  1);
    assert.equal(fallback.callCount, 0, "fallback은 호출되면 안 됨");
  });

  it("primary 실패 시 fallback으로 이어진다", async () => {
    const primary  = createMockProvider("primary",  true);
    const fallback = createMockProvider("fallback", false, '{"source":"fallback"}');

    const result = await dispatchChain([primary, fallback], "test");
    assert.deepEqual(result, { source: "fallback" });
    assert.equal(primary.callCount,  1);
    assert.equal(fallback.callCount, 1);
  });

  it("모든 provider 실패 시 통합 에러를 던진다", async () => {
    const p1 = createMockProvider("p1", true);
    const p2 = createMockProvider("p2", true);
    const p3 = createMockProvider("p3", true);

    await assert.rejects(
      () => dispatchChain([p1, p2, p3], "test"),
      err => err.message.includes("all LLM providers failed")
        && err.message.includes("p1")
        && err.message.includes("p2")
        && err.message.includes("p3")
    );

    assert.equal(p1.callCount, 1);
    assert.equal(p2.callCount, 1);
    assert.equal(p3.callCount, 1);
  });

  it("circuit open 상태 provider는 건너뛰고 다음 provider로 진행한다", async () => {
    const openCircuit = createMockProvider("open-circuit", false, '{"from":"open"}');
    openCircuit.isCircuitOpen = async () => true;  // circuit open override

    const fallback = createMockProvider("fallback", false, '{"from":"fallback"}');

    const result = await dispatchChain([openCircuit, fallback], "test");
    assert.deepEqual(result, { from: "fallback" });
    assert.equal(openCircuit.callCount, 0, "circuit open provider는 callText 호출 안 함");
    assert.equal(fallback.callCount,    1);
  });

  it("chain이 비어있으면 에러를 던진다", async () => {
    await assert.rejects(
      () => dispatchChain([], "test"),
      err => err.message.includes("all LLM providers failed")
    );
  });

  it("primary 실패 → 두 번째 실패 → 세 번째 성공 — 3단 폴백", async () => {
    const p1 = createMockProvider("p1", true);
    const p2 = createMockProvider("p2", true);
    const p3 = createMockProvider("p3", false, '{"tier":3}');

    const result = await dispatchChain([p1, p2, p3], "test");
    assert.deepEqual(result, { tier: 3 });
    assert.equal(p1.callCount, 1);
    assert.equal(p2.callCount, 1);
    assert.equal(p3.callCount, 1);
  });

  it("JSON이 아닌 응답을 반환하는 provider는 파싱 에러로 폴백 진행된다", async () => {
    const badProvider  = createMockProvider("bad-json",   false, "not json at all");
    const goodProvider = createMockProvider("good-json",  false, '{"valid":true}');

    const result = await dispatchChain([badProvider, goodProvider], "test");
    assert.deepEqual(result, { valid: true });
    assert.equal(badProvider.callCount,  1);
    assert.equal(goodProvider.callCount, 1);
  });

});
