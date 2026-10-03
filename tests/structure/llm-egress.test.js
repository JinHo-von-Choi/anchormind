/**
 * LLM 외부 전송 경로 구조 검사
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 기억 내용이 LLM 제공자로 나가는 경로는 모두 외부 전송 관문(lib/llm/EgressGate.js)을 지난다.
 * lib, scripts, bin의 소스를 정적으로 읽어 tests/structure/_llm-egress-rules.js의 규칙을 검사한다.
 * 규칙이 관문을 거치지 않는 경로를 실제로 잡는지는 llm-egress-mutation.test.js가 소스 사본에 위반을 넣어 확인한다.
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";
import { readFileSync } from "node:fs";
import path             from "node:path";

import { listSourceFiles, ROOT } from "./_source-scan.js";
import { checkEgressStructure }  from "./_llm-egress-rules.js";

const SOURCES = new Map(
  [...listSourceFiles("lib"), ...listSourceFiles("scripts"), ...listSourceFiles("bin")]
    .map(file => [file, readFileSync(path.join(ROOT, file), "utf8")])
);
const RESULT = checkEgressStructure(SOURCES);

describe("LLM 외부 전송 경로 구조", () => {
  for (const rule of [
    "providerCalls", "providerImports", "runnerImports", "dispatchImports", "namespaceImports",
    "dynamicImports", "gateInDispatch", "gateInLlmJson", "callerContext"
  ]) {
    it(`${rule} 위반이 없다`, () => {
      assert.deepEqual(RESULT[rule], []);
    });
  }

  it("LLM을 쓰는 여섯 모듈이 진입 함수 호출 모듈로 인식된다", () => {
    for (const expected of [
      "lib/memory/link/ContradictionDetector.js",
      "lib/memory/processors/AutoReflect.js",
      "lib/memory/signals/MemoryEvaluator.js",
      "lib/memory/consolidate/ConsolidatorGC.js",
      "lib/memory/embedding/SyntheticQueryGenerator.js",
      "lib/memory/embedding/MorphemeIndex.js"
    ]) {
      assert.ok(RESULT.callers.includes(expected), `${expected}는 LLM 진입 함수 호출 모듈로 인식되어야 한다`);
    }
  });
});
