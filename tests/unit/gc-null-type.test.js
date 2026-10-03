import { test, describe } from "node:test";
import assert from "node:assert/strict";

describe("GC null type handling", () => {
  test("만료 후보 조건에 NULL type 조건이 포함되어 있다", async () => {
    const { GC_CANDIDATE_FROM } = await import("../../lib/memory/consolidate/FragmentGC.js");
    assert.ok(GC_CANDIDATE_FROM.includes("f.type IS NULL"), "NULL type 파편 GC 조건 필수");
  });
});
