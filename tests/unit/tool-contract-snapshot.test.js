/**
 * 도구 계약 스냅샷 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-08-28
 *
 * 리팩토링이 MCP 표면을 바꾸지 않았음을 기계가 판정하게 한다. 도구 이름,
 * 파라미터 이름, 타입, 필수 여부, enum 값만 본다. 설명 문구는 자유롭게
 * 고칠 수 있어야 하므로 제외한다.
 *
 * 스냅샷을 갱신해야 한다면 그것은 의도적인 표면 변경이라는 뜻이다.
 * SNAPSHOT_UPDATE=1 로 갱신하고 사유를 CHANGELOG에 남긴다.
 */

import { test, describe } from "node:test";
import assert             from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath }  from "node:url";
import path               from "node:path";

import { getToolsDefinition } from "../../lib/tools/index.js";

const HERE          = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = path.join(HERE, "..", "fixtures", "tool-contract.snapshot.json");

/**
 * JSON Schema 속성 하나에서 계약에 해당하는 부분만 뽑는다.
 * 설명과 예시는 표면 계약이 아니므로 버린다.
 *
 * @param {Object} schema
 * @returns {Object}
 */
function normalizeProperty(schema) {
  if (!schema || typeof schema !== "object") return {};
  const out = {};
  if (schema.type !== undefined)  out.type  = schema.type;
  if (Array.isArray(schema.enum)) out.enum  = [...schema.enum].sort();
  if (schema.items)               out.items = normalizeProperty(schema.items);
  if (schema.properties) {
    out.properties = Object.fromEntries(
      Object.keys(schema.properties).sort().map(k => [k, normalizeProperty(schema.properties[k])])
    );
  }
  if (Array.isArray(schema.required)) out.required = [...schema.required].sort();
  return out;
}

/**
 * 도구 정의 목록을 비교 가능한 형태로 정규화한다.
 * 키 순서와 배열 순서에 의존하지 않도록 전부 정렬한다.
 *
 * @param {Array<Object>} tools
 * @returns {Object}
 */
export function normalizeToolContract(tools) {
  const entries = tools
    .map(t => [t.name, {
      properties: Object.fromEntries(
        Object.keys(t.inputSchema?.properties ?? {}).sort()
          .map(k => [k, normalizeProperty(t.inputSchema.properties[k])])
      ),
      required: [...(t.inputSchema?.required ?? [])].sort()
    }])
    .sort(([a], [b]) => a.localeCompare(b));
  return Object.fromEntries(entries);
}

/** 마스터 키(null)는 갱신 도구 2종이 추가로 노출되므로 두 범위를 모두 고정한다. */
function buildSnapshot() {
  return {
    scoped: normalizeToolContract(getToolsDefinition("some-key-id")),
    master: normalizeToolContract(getToolsDefinition(null))
  };
}

describe("도구 계약 스냅샷", () => {
  const current = buildSnapshot();

  if (process.env.SNAPSHOT_UPDATE === "1") {
    writeFileSync(SNAPSHOT_PATH, JSON.stringify(current, null, 2) + "\n");
  }

  test("스냅샷 파일이 존재한다", () => {
    assert.ok(existsSync(SNAPSHOT_PATH), `스냅샷이 없다. SNAPSHOT_UPDATE=1 로 생성하라: ${SNAPSHOT_PATH}`);
  });

  test("스코프 키 도구 계약이 스냅샷과 일치한다", () => {
    const saved = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
    assert.deepEqual(current.scoped, saved.scoped);
  });

  test("마스터 키 도구 계약이 스냅샷과 일치한다", () => {
    const saved = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
    assert.deepEqual(current.master, saved.master);
  });

  test("마스터 키에서만 갱신 도구가 노출된다", () => {
    const scopedNames = Object.keys(current.scoped);
    const masterNames = Object.keys(current.master);
    const extra       = masterNames.filter(n => !scopedNames.includes(n));
    assert.deepEqual(extra.sort(), ["apply_update", "check_update"]);
  });

  test("정규화는 설명 문구를 계약에 포함하지 않는다", () => {
    const withDesc = normalizeToolContract([{
      name: "t",
      inputSchema: { type: "object", properties: { a: { type: "string", description: "설명", examples: ["x"] } }, required: ["a"] }
    }]);
    assert.deepEqual(withDesc.t.properties.a, { type: "string" });
  });

  test("정규화는 키 순서에 의존하지 않는다", () => {
    const mk = (props) => [{ name: "t", inputSchema: { type: "object", properties: props, required: [] } }];
    const a  = normalizeToolContract(mk({ b: { type: "string" }, a: { type: "number" } }));
    const b  = normalizeToolContract(mk({ a: { type: "number" }, b: { type: "string" } }));
    assert.deepEqual(a, b);
  });
});
