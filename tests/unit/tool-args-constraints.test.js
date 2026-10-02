/**
 * 도구 인자 점검의 길이, 개수, 형식, 대안 형태 규칙과 amend 본문 상한 시험.
 * 실제 validateToolArgs, normalizeKeywords, MemoryRememberer.amend를 호출한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */
import { describe, it, afterEach } from "node:test";
import assert                      from "node:assert/strict";

process.env.DOTENV_CONFIG_PATH      ??= ".env.test";
process.env.MEMENTO_METRICS_DEFAULT ??= "off";
process.env.REDIS_ENABLED           ??= "false";
process.env.CACHE_ENABLED           ??= "false";

const { validateToolArgs }         = await import("../../lib/jsonrpc.js");
const { normalizeKeywords }        = await import("../../lib/memory/write/FragmentFactory.js");
const { MemoryRememberer }         = await import("../../lib/memory/processors/MemoryRememberer.js");
const { MAX_CONTENT_INPUT_LENGTH } = await import("../../lib/memory/contentGuard.js");

const SAVED = process.env.MEMENTO_TOOL_ARGS_VALIDATION;
afterEach(() => {
  if (SAVED === undefined) delete process.env.MEMENTO_TOOL_ARGS_VALIDATION;
  else process.env.MEMENTO_TOOL_ARGS_VALIDATION = SAVED;
});

function enforce(name, args) {
  process.env.MEMENTO_TOOL_ARGS_VALIDATION = "enforce";
  return () => validateToolArgs(name, args);
}

describe("validateToolArgs 길이와 개수", () => {
  it("remember content가 maxLength를 넘으면 enforce에서 거부한다", () => {
    const content = "x".repeat(MAX_CONTENT_INPUT_LENGTH + 1);
    assert.throws(enforce("remember", { content, topic: "t", type: "fact" }),
      (e) => e.code === -32602 && /content: length \d+ > \d+/.test(e.message));
  });

  it("maxLength 이내는 통과한다", () => {
    assert.doesNotThrow(enforce("remember", { content: "x".repeat(MAX_CONTENT_INPUT_LENGTH), topic: "t", type: "fact" }));
  });

  it("agentId 128자 초과를 거부한다", () => {
    assert.throws(enforce("recall", { text: "q", agentId: "a".repeat(129) }), /agentId: length 129 > 128/);
  });

  it("batch_remember fragments 200건 초과를 거부한다", () => {
    const fragments = Array.from({ length: 201 }, () => ({ content: "c", topic: "t", type: "fact" }));
    assert.throws(enforce("batch_remember", { fragments }), /fragments: 201 items > 200/);
  });

  it("batch_remember 항목 안의 content 길이도 본다", () => {
    const fragments = [{ content: "x".repeat(MAX_CONTENT_INPUT_LENGTH + 1), topic: "t", type: "fact" }];
    assert.throws(enforce("batch_remember", { fragments }), /fragments\[0\]\.content: length/);
  });
});

describe("validateToolArgs 대안 형태와 형식 표기", () => {
  it("reflect summary는 문자열과 문자열 배열을 모두 받는다", () => {
    assert.doesNotThrow(enforce("reflect", { summary: "s" }));
    assert.doesNotThrow(enforce("reflect", { summary: ["a", "b"] }));
  });

  it("reflect summary가 숫자면 거부한다", () => {
    assert.throws(enforce("reflect", { summary: 3 }), /summary: matches none of the allowed forms \(got number\)/);
  });

  it("타입 위반에는 받은 형식을 함께 적는다", () => {
    assert.throws(enforce("remember", { content: "c", topic: "t", type: "fact", keywords: [2026] }),
      /keywords\[0\]: expected string \(got number\)/);
  });
});

describe("normalizeKeywords", () => {
  it("유한한 숫자는 문자열로 바꾸고 문자열은 소문자로 바꾼다", () => {
    assert.deepEqual(normalizeKeywords(["Redis", 2026]), ["redis", "2026"]);
  });

  it("객체와 null은 -32602로 거부한다", () => {
    assert.throws(() => normalizeKeywords([{ a: 1 }]), (e) => e.code === -32602 && /keywords\[0\] must be a string/.test(e.message));
    assert.throws(() => normalizeKeywords(["ok", null]), /keywords\[1\]/);
  });
});

describe("amend 본문 상한", () => {
  it("상한을 넘는 content는 저장 계층에 닿기 전에 거부한다", async () => {
    const touched = [];
    const r = new MemoryRememberer({
      store: new Proxy({}, { get: (_t, prop) => () => { touched.push(prop); return null; } })
    });
    await assert.rejects(
      () => r.amend({ id: "frag-0000000000000000", content: "x".repeat(MAX_CONTENT_INPUT_LENGTH + 1) }),
      (e) => e.code === -32602
    );
    assert.deepEqual(touched, []);
  });
});
