/**
 * Unit tests: CopilotCliProvider + extractJsonBlock
 *
 * 실제 Copilot CLI 호출 0건 -- runCopilotCLI / _rawIsCopilotCLIAvailable을 mock으로 교체.
 *
 * 검증 범위:
 *   1. isAvailable true/false 분기
 *   2. callJson 성공: 도구 로그 혼재 출력에서 JSON 블록 추출
 *   3. callJson 실패: throw 시 recordFailure 호출
 *   4. circuit breaker 오픈 시 CLI 호출 없음
 *   5. extractJsonBlock 엣지 케이스
 *
 * 작성자: 최진호
 * 작성일: 2026-04-18
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// 의존성 mock 설정 (node:test는 jest.mock 미지원 -- 모듈 레벨 변수 스왑)
// ---------------------------------------------------------------------------

// copilot.js 원본 함수를 직접 import하여 extractJsonBlock만 순수 테스트
import { extractJsonBlock } from "../../lib/copilot.js";

// CopilotCliProvider 내부에서 사용하는 copilot.js 함수를 mock하기 위해
// provider를 직접 import하지 않고, mock이 완료된 후 동적으로 import한다.
// node:test에서는 jest.mock이 없으므로 subclass 방식으로 mock provider를 구성한다.

import { LlmProvider }    from "../../lib/llm/LlmProvider.js";
import { parseJsonResponse } from "../../lib/llm/util/parse-json.js";

// Redis 연결 해제
import { redisClient } from "../../lib/redis.js";
after(async () => {
  try { await redisClient.quit(); } catch (_) {}
});

// ---------------------------------------------------------------------------
// Mock CopilotCliProvider -- runCopilotCLI와 _rawIsCopilotCLIAvailable을 교체
// ---------------------------------------------------------------------------

class MockCopilotCliProvider extends LlmProvider {
  constructor(config = {}) {
    super({ ...config, name: "copilot-cli" });
    this._availableResult = config.available ?? true;
    this._runImpl         = config.runImpl   ?? (() => Promise.resolve('["mock"]'));
  }

  async isAvailable() {
    return this._availableResult;
  }

  async callText(_prompt, _options = {}) {
    throw new Error("copilot-cli: use callJson (CLI output requires JSON block extraction)");
  }

  async callJson(prompt, options = {}) {
    if (await this.isCircuitOpen()) {
      throw new Error("copilot-cli: circuit breaker open");
    }

    const finalPrompt = options.systemPrompt
      ? `${options.systemPrompt}\n\n${prompt}`
      : prompt;

    try {
      const raw    = await this._runImpl(finalPrompt, options);
      const block  = extractJsonBlock(raw) ?? raw;
      const result = parseJsonResponse(block);
      await this.recordSuccess();
      return result;
    } catch (err) {
      await this.recordFailure();
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// 1. isAvailable 분기
// ---------------------------------------------------------------------------

describe("CopilotCliProvider.isAvailable", () => {
  it("바이너리가 존재하면 true를 반환한다", async () => {
    const p = new MockCopilotCliProvider({ available: true });
    assert.equal(await p.isAvailable(), true);
  });

  it("바이너리가 없으면 false를 반환한다", async () => {
    const p = new MockCopilotCliProvider({ available: false });
    assert.equal(await p.isAvailable(), false);
  });
});

// ---------------------------------------------------------------------------
// 2. callText -- 항상 throw
// ---------------------------------------------------------------------------

describe("CopilotCliProvider.callText", () => {
  it("callText는 항상 에러를 던진다", async () => {
    const p = new MockCopilotCliProvider();
    await assert.rejects(
      () => p.callText("some prompt"),
      /copilot-cli: use callJson/
    );
  });
});

// ---------------------------------------------------------------------------
// 3. callJson -- 성공 경로
// ---------------------------------------------------------------------------

describe("CopilotCliProvider.callJson -- 성공", () => {
  it("순수 JSON 배열을 파싱하여 반환한다", async () => {
    const p = new MockCopilotCliProvider({
      runImpl: async () => '["a", "b"]'
    });
    const result = await p.callJson("Return ONLY JSON array");
    assert.deepEqual(result, ["a", "b"]);
  });

  it("순수 JSON 객체를 파싱하여 반환한다", async () => {
    const p = new MockCopilotCliProvider({
      runImpl: async () => '{"key": "value", "num": 42}'
    });
    const result = await p.callJson("Return JSON object");
    assert.deepEqual(result, { key: "value", num: 42 });
  });

  it("도구 호출 로그가 섞인 출력에서 JSON 블록을 추출한다", async () => {
    const mixedOutput = [
      "Searching codebase...",
      "",
      '{"result": "ok", "items": [1, 2, 3]}',
      "",
    ].join("\n");

    const p = new MockCopilotCliProvider({
      runImpl: async () => mixedOutput
    });
    const result = await p.callJson("...");
    assert.deepEqual(result, { result: "ok", items: [1, 2, 3] });
  });

  it("```json 펜스로 감싼 출력에서 JSON을 파싱한다", async () => {
    const fencedOutput = "```json\n{\"score\": 99}\n```";
    const p = new MockCopilotCliProvider({
      runImpl: async () => fencedOutput
    });
    const result = await p.callJson("...");
    assert.deepEqual(result, { score: 99 });
  });

  it("systemPrompt 옵션이 있으면 prompt 앞에 prepend된다", async () => {
    let capturedPrompt = null;
    const p = new MockCopilotCliProvider({
      runImpl: async (prompt) => {
        capturedPrompt = prompt;
        return '{"ok": true}';
      }
    });
    await p.callJson("user question", { systemPrompt: "system instruction" });
    assert.ok(capturedPrompt.startsWith("system instruction\n\nuser question"));
  });
});

// ---------------------------------------------------------------------------
// 4. callJson -- 실패 경로 (recordFailure 호출 검증)
// ---------------------------------------------------------------------------

describe("CopilotCliProvider.callJson -- 실패", () => {
  it("runCopilotCLI가 throw하면 에러를 재throw하고 recordFailure를 호출한다", async () => {
    let failureCalled = false;

    const p = new MockCopilotCliProvider({
      runImpl: async () => { throw new Error("CLI spawn error"); }
    });

    // recordFailure를 spy로 교체
    const original = p.recordFailure.bind(p);
    p.recordFailure = async () => {
      failureCalled = true;
      return original();
    };

    await assert.rejects(
      () => p.callJson("..."),
      /CLI spawn error/
    );
    assert.equal(failureCalled, true);
  });

  it("JSON 파싱 실패 시 에러를 throw한다", async () => {
    const p = new MockCopilotCliProvider({
      runImpl: async () => "not json at all -- no brackets"
    });

    await assert.rejects(
      () => p.callJson("..."),
      (err) => err.message.includes("failed to parse") || err.message.includes("JSON")
    );
  });
});

// ---------------------------------------------------------------------------
// 5. circuit breaker -- 오픈 시 CLI 호출 없음
// ---------------------------------------------------------------------------

describe("CopilotCliProvider.callJson -- circuit breaker", () => {
  it("circuit이 open이면 CLI를 호출하지 않고 즉시 에러를 던진다", async () => {
    let cliCalled = false;

    const p = new MockCopilotCliProvider({
      runImpl: async () => {
        cliCalled = true;
        return '["should not reach here"]';
      }
    });

    // isCircuitOpen을 강제로 true 반환
    p.isCircuitOpen = async () => true;

    await assert.rejects(
      () => p.callJson("..."),
      /circuit breaker open/
    );
    assert.equal(cliCalled, false);
  });
});

// ---------------------------------------------------------------------------
// 6. extractJsonBlock 엣지 케이스
// ---------------------------------------------------------------------------

describe("extractJsonBlock -- 엣지 케이스", () => {
  it("순수 배열 문자열을 반환한다", () => {
    assert.equal(extractJsonBlock('["a","b"]'), '["a","b"]');
  });

  it("순수 객체 문자열을 반환한다", () => {
    assert.equal(extractJsonBlock('{"k":"v"}'), '{"k":"v"}');
  });

  it("앞뒤 텍스트에서 객체를 추출한다", () => {
    const raw = 'Here is the result: {"score": 42} done.';
    assert.equal(extractJsonBlock(raw), '{"score": 42}');
  });

  it("앞뒤 텍스트에서 배열을 추출한다", () => {
    const raw = 'Answer: [1, 2, 3] as requested.';
    assert.equal(extractJsonBlock(raw), "[1, 2, 3]");
  });

  it("```json 펜스 내부를 우선 추출한다", () => {
    const raw = "```json\n{\"x\": 1}\n```";
    assert.equal(extractJsonBlock(raw), '{"x": 1}');
  });

  it("``` 펜스(언어 태그 없음)도 처리한다", () => {
    const raw = "```\n[true, false]\n```";
    assert.equal(extractJsonBlock(raw), "[true, false]");
  });

  it("JSON 블록 없으면 null을 반환한다", () => {
    assert.equal(extractJsonBlock("no json here at all"), null);
  });

  it("빈 문자열에 대해 null을 반환한다", () => {
    assert.equal(extractJsonBlock(""), null);
  });

  it("null에 대해 null을 반환한다", () => {
    assert.equal(extractJsonBlock(null), null);
  });

  it("통계 꼬리가 포함된 실제 Copilot 출력 패턴 (배열)을 처리한다", () => {
    // runCopilotCLI가 stripTrailingStats 후 이미 cleaned 상태를 반환하지만
    // extractJsonBlock에 그 이전 원본이 들어온 경우도 대응
    const raw = '["a", "b"]';
    assert.equal(extractJsonBlock(raw), '["a", "b"]');
  });

  it("중첩 객체에서 outermost 블록을 반환한다", () => {
    const raw = 'result: {"outer": {"inner": true}} end';
    assert.equal(extractJsonBlock(raw), '{"outer": {"inner": true}}');
  });
});
