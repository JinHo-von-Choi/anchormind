/**
 * 멱등성 선언과 구현 일치 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-08-28
 *
 * 도구가 스스로 멱등하다고 선언했으면 같은 인자의 재호출이 상태를 더 바꾸지
 * 않아야 한다. 선언과 구현이 어긋나면 클라이언트가 재시도해도 되는지 판단할
 * 근거가 사라진다.
 *
 * 멱등이 아닌 쓰기 도구는 대신 `idempotencyKey`로 재시도 수단을 제공해야 한다.
 * 둘 중 하나도 없는 쓰기 도구는 재시도가 불가능하다는 뜻이므로 실패로 본다.
 */

import { test, describe } from "node:test";
import assert             from "node:assert/strict";

import { getToolsDefinition } from "../../lib/tools/index.js";

/** 상태를 바꾸는 도구. 읽기 전용은 재시도 논의 대상이 아니다. */
const WRITE_TOOLS = new Set([
  "remember", "batch_remember", "forget", "link", "amend", "reflect",
  "tool_feedback", "memory_consolidate", "session_rotate"
]);

/**
 * 재시도 수단이 없어도 되는 도구와 그 사유.
 *
 * 사유 없이 여기에 이름을 올리면 이 시험은 의미를 잃는다.
 */
const EXEMPT = {
  /** 세션 회전은 회전 자체가 목적이며 두 번 돌리면 두 개의 세션이 생기는 것이 정상이다. */
  session_rotate: "회전 횟수가 곧 의미다",
  /** 통합은 주기 배치이고 대상 집합이 매번 다르다. 같은 인자라는 개념이 성립하지 않는다. */
  memory_consolidate: "대상 집합이 호출 시점에 결정된다"
};

const tools = getToolsDefinition(null);
const byName = new Map(tools.map(t => [t.name, t]));

/**
 * 도구가 재시도 수단을 갖췄는지 판정한다.
 *
 * 일괄 도구는 항목마다 키를 받는다. 배치 전체를 다시 던져도 항목 단위로
 * 중복이 흡수되므로 최상위 키가 없어도 재시도가 안전하다.
 */
function retrySupport(tool) {
  const props      = tool.inputSchema?.properties ?? {};
  const idempotent = tool.annotations?.idempotentHint === true;
  const hasKey     = "idempotencyKey" in props;
  const perItemKey = Object.values(props).some(p =>
    p?.type === "array" && "idempotencyKey" in (p.items?.properties ?? {}));
  return { idempotent, hasKey: hasKey || perItemKey };
}

describe("멱등성 선언", () => {
  test("모든 쓰기 도구가 재시도 수단을 갖는다", () => {
    const missing = [];
    for (const name of WRITE_TOOLS) {
      if (name in EXEMPT) continue;
      const tool = byName.get(name);
      assert.ok(tool, `${name} 도구가 목록에 없다`);
      const { idempotent, hasKey } = retrySupport(tool);
      if (!idempotent && !hasKey) missing.push(name);
    }
    assert.deepEqual(missing, [], `멱등 선언도 idempotencyKey도 없는 쓰기 도구: ${missing.join(", ")}`);
  });

  test("멱등하다고 선언한 도구는 idempotencyKey를 요구하지 않는다", () => {
    for (const name of WRITE_TOOLS) {
      const tool = byName.get(name);
      const { idempotent } = retrySupport(tool);
      if (!idempotent) continue;
      const required = tool.inputSchema?.required ?? [];
      assert.ok(!required.includes("idempotencyKey"),
        `${name}은 멱등 선언인데 idempotencyKey를 필수로 요구한다`);
    }
  });

  test("link는 멱등으로 선언돼 있다", () => {
    assert.equal(byName.get("link").annotations?.idempotentHint, true);
  });

  test("forget은 멱등이면서 파괴적으로 선언돼 있다", () => {
    const ann = byName.get("forget").annotations;
    assert.equal(ann?.idempotentHint, true);
    assert.equal(ann?.destructiveHint, true);
  });

  test("batch_remember는 항목 단위로 idempotencyKey를 받는다", () => {
    const items = byName.get("batch_remember").inputSchema.properties.fragments;
    assert.equal(items.type, "array");
    assert.ok("idempotencyKey" in items.items.properties, "항목 스키마에 idempotencyKey가 없다");
  });

  test("amend, reflect, tool_feedback은 idempotencyKey를 받는다", () => {
    for (const name of ["amend", "reflect", "tool_feedback"]) {
      const props = byName.get(name).inputSchema?.properties ?? {};
      assert.ok("idempotencyKey" in props, `${name}에 idempotencyKey가 없다`);
      assert.equal(props.idempotencyKey.type, "string");
      assert.equal(props.idempotencyKey.maxLength, 128);
    }
  });

  test("읽기 전용 도구는 멱등 선언과 모순되지 않는다", () => {
    for (const tool of tools) {
      const ann = tool.annotations;
      if (ann?.readOnlyHint !== true) continue;
      assert.notEqual(ann.idempotentHint, false,
        `${tool.name}은 읽기 전용인데 멱등이 아니라고 선언한다`);
    }
  });

  test("면제 목록의 도구가 실제로 존재한다", () => {
    for (const name of Object.keys(EXEMPT)) {
      assert.ok(byName.has(name), `면제 목록의 ${name}이 도구 목록에 없다`);
    }
  });
});
