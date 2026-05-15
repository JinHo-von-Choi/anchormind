import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

function runDisabledOnnxSnippet(script) {
  return execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      MEMENTO_INPROCESS_ONNX_ENABLED: "false",
      MEMENTO_METRICS_DEFAULT: "off",
      RERANKER_URL: "",
      NLI_SERVICE_URL: ""
    }
  });
}

describe("MEMENTO_INPROCESS_ONNX_ENABLED=false", () => {
  it("disables the in-process reranker without loading an ONNX model", () => {
    const stdout = runDisabledOnnxSnippet(`
      import assert from "node:assert/strict";
      const mod = await import("./lib/memory/Reranker.js");
      assert.equal(mod.isRerankerAvailable(), false);
      await mod.preloadReranker();
      const candidates = [{ id: "a", content: "alpha", importance: 0.4 }];
      const result = await mod.rerank("alpha", candidates, 1);
      assert.deepEqual(result, candidates);
      console.log("reranker-disabled-pass");
    `);
    assert.match(stdout, /reranker-disabled-pass/);
  });

  it("disables the in-process NLI classifier without loading an ONNX model", () => {
    const stdout = runDisabledOnnxSnippet(`
      import assert from "node:assert/strict";
      const mod = await import("./lib/memory/signals/NLIClassifier.js");
      assert.equal(mod.isNLIAvailable(), false);
      await mod.preloadNLI();
      assert.equal(await mod.classifyNLI("a premise", "a hypothesis"), null);
      console.log("nli-disabled-pass");
    `);
    assert.match(stdout, /nli-disabled-pass/);
  });
});
