/**
 * 도구 정의 정합 검사
 *
 * 작성자: 최진호
 * 작성일: 2026-09-30
 *
 * tools/list 가 노출하는 정의 목록이 스스로 모순되지 않는지, 그리고 레지스트리와
 * 어긋나지 않는지 구조만 본다. 출력 전체를 고정하지 않으므로 설명 문구나 속성 추가는
 * 자유롭고, 이름 누락, 필수 키 오타, 타입 없는 속성, 핸들러 없는 도구 같은 구조 결함만 잡는다.
 */

import { describe, test } from "node:test";
import assert             from "node:assert/strict";

import { getToolsDefinition } from "../../lib/tools/index.js";
import { TOOL_REGISTRY }      from "../../lib/tool-registry.js";

const SCOPED = getToolsDefinition("some-key-id");
const MASTER = getToolsDefinition(null, true);

/**
 * 스키마 노드를 재귀로 순회하며 구조 위반 메시지를 모은다.
 *
 * @param {Object} node
 * @param {string} where
 * @param {string[]} errors
 */
function collectSchemaErrors(node, where, errors) {
  if (!node || typeof node !== "object") {
    errors.push(`${where}: 스키마가 객체가 아니다`);
    return;
  }
  if (node.enum !== undefined) {
    if (!Array.isArray(node.enum) || node.enum.length === 0) {
      errors.push(`${where}: enum이 비어 있다`);
    } else if (new Set(node.enum).size !== node.enum.length) {
      errors.push(`${where}: enum에 중복 값이 있다`);
    }
  }
  if (node.maxLength !== undefined && !(Number.isInteger(node.maxLength) && node.maxLength >= 0)) {
    errors.push(`${where}: maxLength가 0 이상의 정수가 아니다`);
  }
  if (node.type === "array") {
    if (!node.items) errors.push(`${where}: 배열에 items가 없다`);
    else collectSchemaErrors(node.items, `${where}[]`, errors);
  }
  if (node.properties !== undefined) {
    if (typeof node.properties !== "object" || node.properties === null) {
      errors.push(`${where}: properties가 객체가 아니다`);
      return;
    }
    for (const [key, child] of Object.entries(node.properties)) {
      const childWhere = `${where}.${key}`;
      const hasShape   = child && (child.type || child.enum || child.oneOf || child.anyOf);
      if (!hasShape) errors.push(`${childWhere}: type/enum/oneOf/anyOf 중 어느 것도 없다`);
      collectSchemaErrors(child, childWhere, errors);
    }
  }
  if (node.required !== undefined) {
    if (!Array.isArray(node.required)) {
      errors.push(`${where}: required가 배열이 아니다`);
    } else {
      const known = Object.keys(node.properties ?? {});
      for (const key of node.required) {
        if (!known.includes(key)) errors.push(`${where}: required "${key}"가 properties에 없다`);
      }
    }
  }
}

for (const [label, tools] of [["일반 키", SCOPED], ["마스터 키", MASTER]]) {
  describe(`도구 정의 구조 (${label})`, () => {
    test("도구가 하나 이상 노출된다", () => {
      assert.ok(tools.length > 0);
    });

    test("이름은 비어 있지 않은 문자열이며 중복이 없다", () => {
      const names = tools.map(t => t.name);
      for (const name of names) {
        assert.equal(typeof name, "string");
        assert.match(name, /^[a-z][a-z0-9_]*$/, `도구 이름 형식 오류: ${name}`);
      }
      assert.equal(new Set(names).size, names.length, "도구 이름이 중복된다");
    });

    test("모든 도구가 설명 문자열을 가진다", () => {
      for (const t of tools) {
        assert.ok(typeof t.description === "string" && t.description.trim().length > 0, `${t.name}: description 누락`);
      }
    });

    test("inputSchema는 type object이며 properties가 객체다", () => {
      for (const t of tools) {
        assert.equal(t.inputSchema?.type, "object", `${t.name}: inputSchema.type`);
        assert.ok(t.inputSchema.properties && typeof t.inputSchema.properties === "object", `${t.name}: properties`);
      }
    });

    test("속성 스키마에 구조 위반이 없다", () => {
      const errors = [];
      for (const t of tools) collectSchemaErrors(t.inputSchema, t.name, errors);
      assert.deepEqual(errors, []);
    });
  });
}

describe("도구 정의와 레지스트리 정합", () => {
  test("노출된 모든 도구에 함수 핸들러가 등록되어 있다", () => {
    for (const t of MASTER) {
      const entry = TOOL_REGISTRY.get(t.name);
      assert.ok(entry, `레지스트리에 ${t.name} 없음`);
      assert.equal(typeof entry.handler, "function", `${t.name}: handler가 함수가 아니다`);
    }
  });

  test("레지스트리의 모든 도구가 마스터 정의 목록에 노출된다", () => {
    const listed = new Set(MASTER.map(t => t.name));
    for (const name of TOOL_REGISTRY.keys()) {
      assert.ok(listed.has(name), `${name}이 tools/list에 노출되지 않는다`);
    }
  });

  test("마스터 전용 표시가 있는 도구는 일반 키 목록에서 빠진다", () => {
    const scopedNames = new Set(SCOPED.map(t => t.name));
    for (const [name, entry] of TOOL_REGISTRY) {
      if (entry.meta.requiresMaster === true) {
        assert.ok(!scopedNames.has(name), `${name}이 일반 키 목록에 노출된다`);
      }
    }
  });

  test("일반 키 목록은 마스터 목록의 부분집합이다", () => {
    const masterNames = new Set(MASTER.map(t => t.name));
    for (const t of SCOPED) assert.ok(masterNames.has(t.name), `${t.name}이 마스터 목록에 없다`);
  });

  test("마스터 목록은 마스터 전용 도구 4종만 추가로 가진다", () => {
    const scopedNames = new Set(SCOPED.map(t => t.name));
    const extra       = MASTER.map(t => t.name).filter(n => !scopedNames.has(n)).sort();
    assert.deepEqual(extra, ["apply_update", "check_update", "memory_consolidate", "memory_stats"]);
  });
});

describe("핵심 도구의 필수 인자", () => {
  const byName = (name) => MASTER.find(t => t.name === name);

  test("remember는 content, topic, type을 요구한다", () => {
    assert.deepEqual([...byName("remember").inputSchema.required].sort(), ["content", "topic", "type"]);
  });

  test("link는 fromId, toId를 요구한다", () => {
    assert.deepEqual([...byName("link").inputSchema.required].sort(), ["fromId", "toId"]);
  });

  test("amend는 id를 요구한다", () => {
    assert.deepEqual(byName("amend").inputSchema.required, ["id"]);
  });

  test("batch_remember는 fragments 배열을 요구한다", () => {
    const t = byName("batch_remember");
    assert.deepEqual(t.inputSchema.required, ["fragments"]);
    assert.equal(t.inputSchema.properties.fragments.type, "array");
  });

  test("recall과 context는 필수 인자가 없다", () => {
    for (const name of ["recall", "context"]) {
      assert.deepEqual(byName(name).inputSchema.required ?? [], [], `${name}: 필수 인자가 생겼다`);
    }
  });

  test("agentId는 128자 이하 문자열로 제한된다", () => {
    for (const name of ["remember", "amend"]) {
      const prop = byName(name).inputSchema.properties.agentId;
      assert.equal(prop.type, "string");
      assert.equal(prop.maxLength, 128);
    }
  });
});
