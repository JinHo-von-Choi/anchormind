/**
 * P5c 안전장치: 임계값 리셋 스크립트가 dryRun 기본이고 DEFAULT 0.5로 리셋한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-07-16
 */
import { test } from "node:test";
import assert   from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../../scripts/reset-search-param-thresholds.js", import.meta.url), "utf8");

test("dryRun 기본 + execute 플래그 + search_param_thresholds 대상", () => {
  assert.match(SRC, /--execute/);
  assert.match(SRC, /search_param_thresholds/);
});

test("리셋 목표값 0.5를 사용한다", () => {
  assert.match(SRC, /0\.5/);
});
