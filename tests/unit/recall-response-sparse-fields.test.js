/**
 * recall 응답 계층 sparse fields·key 필드 게이팅 정적 가드
 *
 * 작성자: 최진호
 * 작성일: 2026-07-16
 *
 * buildRecallResponse가 fields 최종 선택과 key_id/key_name 게이팅을 수행하고,
 * MemoryRecaller가 검색 계층으로 fields를 전달하지 않음을 소스 기준으로 고정한다.
 */

import { describe, it, after } from "node:test";
import assert                  from "node:assert/strict";
import { readFileSync }        from "node:fs";
import { fileURLToPath }       from "node:url";
import path                    from "node:path";

import { teardownTestResources } from "../_lifecycle.js";

after(async () => {
  await teardownTestResources();
});

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const toolsSrc    = readFileSync(path.resolve(__dirname, "../../lib/tools/memory.js"), "utf8");
const recallerSrc = readFileSync(path.resolve(__dirname, "../../lib/memory/processors/MemoryRecaller.js"), "utf8");

describe("recall 응답 sparse fields — 정적 가드", () => {
  it("응답 프로젝션이 fields 요청 키만 남기는 최종 필터를 수행한다", () => {
    assert.match(toolsSrc, /args\.fields\.includes\(key\)/);
  });

  it("key_id/key_name은 includeKeyName === true일 때만 응답에 포함된다", () => {
    assert.match(toolsSrc, /args\.includeKeyName === true && f\.key_id\s+!== undefined/);
    assert.match(toolsSrc, /args\.includeKeyName === true && f\.key_name !== undefined/);
    assert.doesNotMatch(toolsSrc, /\.\.\.\(f\.key_id\s+!== undefined \? \{ key_id/);
  });

  it("MemoryRecaller는 검색 계층으로 fields를 전달하지 않는다", () => {
    assert.doesNotMatch(recallerSrc, /fields: params\.fields/);
  });

  it("fields로 keywords 요청 시 includeKeywords 없이도 포함된다", () => {
    assert.match(toolsSrc, /args\.includeKeywords \|\| \(wantsFields && args\.fields\.includes\("keywords"\)\)/);
  });
});
