/**
 * reflect 스키마 workspace 파라미터 노출 검증
 *
 * 작성자: 최진호
 * 작성일: 2026-07-26
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { reflectDefinition } from "../../lib/tools/memory-schemas.js";

describe("reflect 스키마 workspace", () => {
  it("inputSchema.properties에 workspace가 노출된다", () => {
    const props = reflectDefinition.inputSchema.properties;
    assert.ok(props.workspace, "workspace 프로퍼티가 스키마에 없음");
    assert.equal(props.workspace.type, "string");
  });

  it("workspace 설명이 미지정 시 default_workspace 폴백을 명시한다", () => {
    const desc = reflectDefinition.inputSchema.properties.workspace.description;
    assert.match(desc, /default_workspace/);
  });
});
