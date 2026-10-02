/**
 * 세션 회전 지표 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * mcp_session_rotation_total{outcome}와 mcp_rotate_rate_limited_total이
 * /metrics 레지스트리에 등록되고, outcome 값이 고정 집합 안에 머무는지 검증한다.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  register,
  recordSessionRotation,
  recordRotateRateLimited
} from "../../lib/metrics.js";

const OUTCOMES = new Set(["rotated", "not_found", "expired", "forbidden", "unavailable", "error"]);

describe("세션 회전 지표", () => {
  it("recordSessionRotation은 outcome 라벨 하나로 카운트한다", async () => {
    recordSessionRotation("rotated");
    recordSessionRotation("not_found");
    const metric = register.getSingleMetric("mcp_session_rotation_total");
    assert.ok(metric, "mcp_session_rotation_total 미등록");
    const { values } = await metric.get();
    assert.ok(values.length >= 2);
    for (const v of values) {
      assert.deepEqual(Object.keys(v.labels), ["outcome"]);
      assert.ok(OUTCOMES.has(v.labels.outcome), `허용 집합 밖의 값: ${v.labels.outcome}`);
    }
    assert.ok(values.find(v => v.labels.outcome === "rotated").value >= 1);
  });

  it("recordRotateRateLimited는 라벨 없는 카운터를 올린다", async () => {
    recordRotateRateLimited();
    const metric = register.getSingleMetric("mcp_rotate_rate_limited_total");
    assert.ok(metric, "mcp_rotate_rate_limited_total 미등록");
    const { values } = await metric.get();
    assert.equal(values.length, 1);
    assert.deepEqual(values[0].labels, {});
    assert.ok(values[0].value >= 1);
  });

  it("두 지표가 /metrics 노출 텍스트에 나온다", async () => {
    recordSessionRotation("error");
    const text = await register.metrics();
    assert.match(text, /^mcp_session_rotation_total\{outcome="error"\} \d+/m);
    assert.match(text, /^mcp_rotate_rate_limited_total \d+/m);
  });

  it("핸들러는 모든 기록 호출에 리터럴 outcome을 쓴다", () => {
    const src    = fs.readFileSync(new URL("../../lib/handlers/session-handler.js", import.meta.url), "utf8");
    const calls  = [...src.matchAll(/recordSessionRotation\(([^)]*)\)/g)].map(m => m[1].trim());
    assert.deepEqual(
      calls.sort(),
      ['"error"', '"expired"', '"forbidden"', '"not_found"', '"rotated"', '"unavailable"']
    );
    assert.match(src, /recordRotateRateLimited\(\)/);
  });
});
