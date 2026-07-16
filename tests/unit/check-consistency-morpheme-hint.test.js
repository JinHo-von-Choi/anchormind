/**
 * P2b 회귀 방지: 일관성 점검 경고에 MorphemeBackfill 안내가 포함돼야 한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-07-16
 */
import { test } from "node:test";
import assert   from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../../scripts/check-embedding-consistency.js", import.meta.url), "utf8");

test("morpheme 미인덱싱 경고에 MorphemeBackfill 안내 문자열이 존재한다", () => {
  assert.match(SRC, /MorphemeBackfill/);
});
