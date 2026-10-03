/**
 * 도구 메타데이터 구조 검사
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * tools/list 가 노출하는 모든 정의가 title 과 완전한 annotations 를 가지는지,
 * 힌트 값이 레지스트리의 위험 등급과 어긋나지 않는지, 목록 순서가 정의 순서에
 * 의존하지 않는지, ping 이 빈 결과를 돌려주는지를 구조 수준에서만 본다.
 */

import { describe, test } from "node:test";
import assert             from "node:assert/strict";

import { getToolsDefinition, sortToolsDefinition } from "../../lib/tools/index.js";
import { TOOL_REGISTRY }                           from "../../lib/tool-registry.js";
import { recallDefinition }                        from "../../lib/tools/memory-schemas.js";
import { dispatchJsonRpc }                         from "../../lib/jsonrpc.js";

const MASTER      = getToolsDefinition(null, true);
const HINT_KEYS   = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"];
const WRITE_CAPS  = new Set(["memory:write", "memory:destructive", "session:write"]);
const DASHES      = /[\u2013\u2014\u2015]/;

describe("title", () => {
  test("모든 도구가 비어 있지 않은 title 문자열을 가진다", () => {
    for (const t of MASTER) {
      assert.equal(typeof t.title, "string", `${t.name}: title 누락`);
      assert.ok(t.title.trim().length > 0, `${t.name}: title이 비어 있다`);
    }
  });

  test("title에 줄표 문자가 없다", () => {
    for (const t of MASTER) {
      assert.ok(!DASHES.test(t.title), `${t.name}: title에 줄표 문자가 있다`);
    }
  });

  test("title은 도구마다 서로 다르다", () => {
    const titles = MASTER.map(t => t.title);
    assert.equal(new Set(titles).size, titles.length);
  });
});

describe("annotations", () => {
  test("모든 도구가 네 힌트를 모두 boolean 으로 선언한다", () => {
    for (const t of MASTER) {
      assert.ok(t.annotations && typeof t.annotations === "object", `${t.name}: annotations 누락`);
      for (const key of HINT_KEYS) {
        assert.equal(typeof t.annotations[key], "boolean", `${t.name}.${key}가 boolean이 아니다`);
      }
    }
  });

  test("정의되지 않은 힌트 키가 없다", () => {
    for (const t of MASTER) {
      for (const key of Object.keys(t.annotations)) {
        assert.ok(HINT_KEYS.includes(key), `${t.name}: 알 수 없는 힌트 ${key}`);
      }
    }
  });

  test("파괴적 도구는 destructiveHint true 이고 읽기 전용이 아니다", () => {
    const destructive = new Set(["forget", "amend", "memory_consolidate", "apply_update"]);
    for (const name of destructive) {
      const ann = MASTER.find(t => t.name === name)?.annotations;
      assert.ok(ann, `${name} 정의가 없다`);
      assert.equal(ann.destructiveHint, true, `${name}: destructiveHint`);
      assert.equal(ann.readOnlyHint, false, `${name}: readOnlyHint`);
    }
    for (const t of MASTER) {
      if (TOOL_REGISTRY.get(t.name).meta.riskLevel === "destructive") {
        assert.equal(t.annotations.destructiveHint, true, `${t.name}: 레지스트리가 destructive 인데 힌트가 아니다`);
      }
    }
  });

  test("읽기 전용 도구는 쓰기 capability 를 갖지 않고 파괴적이지 않다", () => {
    for (const t of MASTER) {
      if (t.annotations.readOnlyHint !== true) continue;
      const meta = TOOL_REGISTRY.get(t.name).meta;
      assert.equal(meta.riskLevel, "safe", `${t.name}: 읽기 전용인데 riskLevel이 safe가 아니다`);
      for (const cap of meta.capabilities) {
        assert.ok(!WRITE_CAPS.has(cap), `${t.name}: 읽기 전용인데 쓰기 capability ${cap}를 가진다`);
      }
      assert.equal(t.annotations.destructiveHint, false, `${t.name}: 읽기 전용인데 destructiveHint`);
      assert.equal(t.annotations.idempotentHint, true,   `${t.name}: 읽기 전용인데 멱등이 아니다`);
    }
  });

  test("riskLevel safe 인 도구는 모두 읽기 전용으로 선언된다", () => {
    for (const t of MASTER) {
      if (TOOL_REGISTRY.get(t.name).meta.riskLevel !== "safe") continue;
      assert.equal(t.annotations.readOnlyHint, true, `${t.name}: safe 인데 readOnlyHint가 아니다`);
    }
  });

  test("조회 도구 recall, context, graph_explore 는 읽기 전용이다", () => {
    for (const name of ["recall", "context", "graph_explore"]) {
      assert.equal(MASTER.find(t => t.name === name).annotations.readOnlyHint, true, name);
    }
  });
});

describe("tools/list 순서", () => {
  test("정의 순서를 섞어도 같은 순서가 나온다", () => {
    const expected = sortToolsDefinition(MASTER).map(t => t.name);
    const reversed = sortToolsDefinition([...MASTER].reverse()).map(t => t.name);
    const rotated  = sortToolsDefinition([...MASTER.slice(7), ...MASTER.slice(0, 7)]).map(t => t.name);
    assert.deepEqual(reversed, expected);
    assert.deepEqual(rotated,  expected);
  });

  test("getToolsDefinition 결과는 정렬 결과와 같다", () => {
    assert.deepEqual(MASTER.map(t => t.name), sortToolsDefinition(MASTER).map(t => t.name));
  });

  test("핵심 도구 뒤의 나머지는 이름 오름차순이다", () => {
    const names = MASTER.map(t => t.name);
    const rest  = names.slice(names.indexOf("remember") + 1);
    assert.deepEqual(rest, [...rest].sort());
  });

  test("정렬은 입력 배열을 바꾸지 않는다", () => {
    const input  = [...MASTER].reverse();
    const before = input.map(t => t.name);
    sortToolsDefinition(input);
    assert.deepEqual(input.map(t => t.name), before);
  });
});

describe("asOf 설명", () => {
  test("랭킹 기준 시각으로 설명하고 시점 조회로 설명하지 않는다", () => {
    const text = recallDefinition.inputSchema.properties.asOf.description;
    assert.match(text, /랭킹/);
    assert.match(text, /timeRange/);
    assert.doesNotMatch(text, /시점 기억 조회/);
  });
});

describe("ping", () => {
  test("빈 결과를 돌려준다", async () => {
    const out = await dispatchJsonRpc({ jsonrpc: "2.0", id: 7, method: "ping" },
      { keyId: null, isMaster: true, permissions: null });
    assert.equal(out.kind, "ok");
    assert.equal(out.response.id, 7);
    assert.deepEqual(out.response.result, {});
    assert.equal(out.response.error, undefined);
  });

  test("알림으로 보내면 응답 없이 수락된다", async () => {
    const out = await dispatchJsonRpc({ jsonrpc: "2.0", method: "ping" }, null);
    assert.equal(out.kind, "accepted");
  });

  test("인증 문맥 없이도 동작한다", async () => {
    const out = await dispatchJsonRpc({ jsonrpc: "2.0", id: 1, method: "ping" }, null);
    assert.equal(out.kind, "ok");
    assert.deepEqual(out.response.result, {});
  });
});
