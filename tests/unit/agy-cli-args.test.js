import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildAgyArgs } from "../../lib/agy.js";

describe("buildAgyArgs", () => {
  it("print-only, plan, sandbox flags와 model을 항상 포함한다", () => {
    assert.deepEqual(
      buildAgyArgs("return json", { model: "gemini-3.1-pro" }),
      [
        "--print",
        "--output-format", "text",
        "--mode", "plan",
        "--sandbox",
        "--model", "gemini-3.1-pro",
        "return json"
      ]
    );
  });

  it("model이 없으면 Antigravity CLI 기본 모델을 사용한다", () => {
    assert.deepEqual(
      buildAgyArgs("return json"),
      ["--print", "--output-format", "text", "--mode", "plan", "--sandbox", "return json"]
    );
  });
});
