/**
 * stale-warning 단위 테스트 — computeStale fail-open 검증
 *
 * 작성자: 최진호
 * 작성일: 2026-06-09
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeStale } from "../../lib/memory/processors/MemoryRecaller.js";

const NOW = Date.parse("2026-06-08T00:00:00Z");

test("verified_at 없고 created_at이 오늘이면 stale 아님 (fail-open)", () => {
  const r = computeStale({ type: "error", created_at: "2026-06-08T00:00:00Z" }, NOW);
  assert.equal(r, null);
});

test("verified_at 없고 created_at도 없으면 판정 보류 (경고 없음)", () => {
  const r = computeStale({ type: "error" }, NOW);
  assert.equal(r, null);
});

test("verified_at 없을 때 created_at 기준으로 stale 판정", () => {
  const r = computeStale({ type: "error", created_at: "2026-01-01T00:00:00Z" }, NOW);
  assert.ok(r && r.stale === true);
  assert.ok(r.days_since_verification >= 60);
});

test("verified_at 우선 사용", () => {
  const r = computeStale({ type: "error", verified_at: "2026-06-07T00:00:00Z",
                           created_at: "2026-01-01T00:00:00Z" }, NOW);
  assert.equal(r, null);
});
