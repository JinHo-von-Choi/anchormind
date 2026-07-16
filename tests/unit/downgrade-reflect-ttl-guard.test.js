/**
 * P5b 안전장치: TTL 강등 스크립트가 dryRun 기본 + 앵커 제외여야 한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-07-16
 */
import { test } from "node:test";
import assert   from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../../scripts/downgrade-reflect-ttl.js", import.meta.url), "utf8");

test("dryRun 기본 + execute 플래그", () => {
  assert.match(SRC, /--execute/);
});

test("session_reflect·permanent·앵커 제외 조건을 사용한다", () => {
  assert.match(SRC, /session_reflect/);
  assert.match(SRC, /permanent/);
  assert.match(SRC, /is_anchor\s*=\s*false/);
});
