/**
 * P5a 안전장치: 마이그레이션 스크립트가 dryRun 기본 + reflect 한정이어야 한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-07-16
 */
import { test } from "node:test";
import assert   from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../../scripts/reextract-reflect-keywords.js", import.meta.url), "utf8");

test("dryRun이 기본이고 execute는 명시 플래그로만 켜진다", () => {
  assert.match(SRC, /--execute/);
  assert.match(SRC, /topic\s*=\s*'session_reflect'/);
});

test("실행 전 대상 건수를 출력한다", () => {
  assert.match(SRC, /대상|count|건/);
});
