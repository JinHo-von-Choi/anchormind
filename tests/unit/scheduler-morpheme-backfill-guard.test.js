/**
 * P2a 회귀 방지: 스케줄러가 MorphemeBackfill을 등록해야 한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-07-16
 */
import { test } from "node:test";
import assert   from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../../lib/scheduler.js", import.meta.url), "utf8");

test("scheduler가 processMorphemeBackfill을 import하고 morphemeBackfill 잡을 등록한다", () => {
  assert.match(SRC, /import\s*\{\s*processMorphemeBackfill\s*\}\s*from/);
  assert.match(SRC, /recordSuccess\("morphemeBackfill"/);
  assert.match(SRC, /5\s*\*\s*60_000/);
});
