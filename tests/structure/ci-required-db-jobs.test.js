import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(new URL("../../.github/workflows/test.yml", import.meta.url), "utf8");

describe("필수 DB 정합성 CI", () => {
  it("세 핵심 경합 시험을 별도 blocking job에서 실행한다", () => {
    const start = workflow.indexOf("  db-correctness:");
    assert.ok(start >= 0);
    const block = workflow.slice(start);
    assert.doesNotMatch(block, /continue-on-error:\s*true/);
    assert.match(block, /MEMENTO_REQUIRE_TEST_DB:\s*"true"/);
    for (const file of ["embedding-amend-race", "synthetic-query-amend-race", "forget-cascade"]) {
      assert.match(block, new RegExp(file));
    }
  });
});
