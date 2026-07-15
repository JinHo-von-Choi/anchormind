/**
 * recall/context 경로 includeKeyName 배선 정적 가드
 *
 * 작성자: 최진호
 * 작성일: 2026-07-15
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

const __dirname    = path.dirname(fileURLToPath(import.meta.url));
const searchSrc    = readFileSync(path.resolve(__dirname, "../../lib/memory/read/FragmentSearch.js"), "utf8");
const recallerSrc  = readFileSync(path.resolve(__dirname, "../../lib/memory/processors/MemoryRecaller.js"), "utf8");
const toolsSrc     = readFileSync(path.resolve(__dirname, "../../lib/tools/memory.js"), "utf8");

describe("includeKeyName 배선 — 정적 가드", () => {
  it("FragmentSearch ALLOWED_FIELDS에 key_id/key_name이 포함된다", () => {
    const block = searchSrc.match(/const ALLOWED_FIELDS = new Set\(\[[\s\S]*?\]\)/)[0];
    assert.match(block, /"key_id"/);
    assert.match(block, /"key_name"/);
  });

  it("FragmentSearch가 pickFields 이전에 enrichWithKeyNames를 호출한다", () => {
    assert.match(searchSrc, /enrichWithKeyNames/);
    const enrichPos = searchSrc.indexOf("enrichWithKeyNames(clean)");
    const pickPos   = searchSrc.indexOf("clean.map(f => pickFields(f, query.fields))");
    assert.ok(enrichPos > -1 && pickPos > -1 && enrichPos < pickPos,
      "enrich는 sparse fields pick보다 먼저 실행돼야 한다");
  });

  it("MemoryRecaller.recall이 includeKeyName을 검색 쿼리로 전달한다", () => {
    assert.match(recallerSrc, /params\.includeKeyName === true \? \{ includeKeyName: true \}/);
  });

  it("MemoryRecaller.context가 includeKeyName 시 enrichWithKeyNames를 적용한다", () => {
    assert.match(recallerSrc, /enrichWithKeyNames/);
  });

  it("buildRecallResponse 화이트리스트가 key_id/key_name을 통과시킨다", () => {
    assert.match(toolsSrc, /key_id:\s+f\.key_id/);
    assert.match(toolsSrc, /key_name:\s*f\.key_name/);
  });
});
