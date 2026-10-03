/**
 * LLM 외부 전송 경로 구조 검사
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 기억 내용이 LLM 제공자로 나가는 경로는 모두 외부 전송 관문(lib/llm/EgressGate.js)을 지난다.
 * 소스를 정적으로 읽어 다섯 가지를 본다.
 *
 *   1. 제공자 호출(callJson, callText)은 lib/llm/index.js, lib/llm/LlmProvider.js, lib/llm/providers/ 안에만 있다.
 *   2. 제공자 모듈(lib/llm/providers/)과 제공자 생성(registry.js의 createProvider)은 lib/llm 안에서만 가져온다.
 *      lib/llm 밖은 등록된 이름 목록(listProviderNames)만 가져올 수 있다.
 *   3. dispatchChain의 모든 callJson 호출은 관문의 prepare가 돌려준 sent.prompt, sent.options를 넘기고,
 *      prepare 호출 수는 callJson 호출 수와 같다(호출 직전 확인, EgressPolicy.assertEgressAllowed 경유).
 *   4. llmJson은 openEgressGate로 관문을 열고 egress.filter로 거른 체인을 dispatchChain에 넘긴다.
 *   5. lib, scripts, bin에서 LLM JSON 진입점(llmJson, geminiCLIJson, qwenCLIJson과 그 별칭)을 부르는 곳은
 *      옵션 객체 리터럴에 egress를 싣고, 그 파일이 쓰는 단계 이름은 모두 EGRESS_STAGES에 있다.
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";
import { readFileSync } from "node:fs";
import path             from "node:path";

import { listSourceFiles, scanFile, ROOT } from "./_source-scan.js";
import { EGRESS_STAGES }                   from "../../lib/llm/EgressPolicy.js";

const SOURCES = [...listSourceFiles("lib"), ...listSourceFiles("scripts"), ...listSourceFiles("bin")];
const SCANS   = new Map(SOURCES.map(file => [file, scanFile(file)]));

const PROVIDER_CALL_FILES = (file) =>
  file === "lib/llm/index.js" || file === "lib/llm/LlmProvider.js" || file.startsWith("lib/llm/providers/");

/** LLM JSON 진입점과 그 함수를 내보내는 모듈 */
const ENTRY_MODULES = Object.freeze({
  "lib/llm/index.js": "llmJson",
  "lib/gemini.js"   : "geminiCLIJson",
  "lib/qwen.js"     : "qwenCLIJson"
});

/** import 경로를 저장소 기준 상대 경로로 푼다. */
function resolveImport(file, source) {
  if (typeof source !== "string" || !source.startsWith(".")) return null;
  return path.posix.normalize(path.posix.join(path.posix.dirname(file), source));
}

/**
 * 파일이 LLM 진입점을 부를 때 쓰는 이름. 정적 named import의 지역 이름과,
 * 동적 import 결과를 구조 분해한 별칭(`{ llmJson: call }`, `{ llmJson }`)을 모은다.
 */
function entryNames(file) {
  const scan  = SCANS.get(file);
  const names = new Set();
  for (const spec of scan.importSpecs) {
    const target = resolveImport(file, spec.source);
    if (spec.kind === "named" && target && ENTRY_MODULES[target] === spec.imported) names.add(spec.local);
  }
  const text = readFileSync(path.join(ROOT, file), "utf8");
  for (const [target, exported] of Object.entries(ENTRY_MODULES)) {
    const base = path.posix.basename(target);
    if (!text.includes(base)) continue;
    for (const m of text.matchAll(new RegExp(`\\b${exported}\\s*:\\s*([A-Za-z_$][\\w$]*)`, "g"))) names.add(m[1]);
    if (new RegExp(`\\{[^}]*\\b${exported}\\b(?!\\s*:)[^}]*\\}\\s*=\\s*await import`).test(text)) names.add(exported);
  }
  return names;
}

describe("LLM 외부 전송 경로 구조", () => {
  it("제공자 호출은 lib/llm의 호출기와 제공자 모듈에만 있다", () => {
    const offenders = [];
    for (const [file, scan] of SCANS) {
      if (PROVIDER_CALL_FILES(file)) continue;
      for (const call of scan.calls) {
        if (call.method === "callJson" || call.method === "callText") offenders.push(`${file}:${call.line} ${call.callee}`);
      }
    }
    assert.deepEqual(offenders, []);
  });

  it("제공자 모듈과 제공자 생성은 lib/llm 안에서만 가져온다", () => {
    const offenders = [];
    for (const [file, scan] of SCANS) {
      if (file.startsWith("lib/llm/")) continue;
      for (const spec of scan.importSpecs) {
        const target     = resolveImport(file, spec.source);
        const provider   = target?.startsWith("lib/llm/providers/");
        const namesOnly  = spec.kind === "named" && spec.imported === "listProviderNames";
        if (provider || (target === "lib/llm/registry.js" && !namesOnly)) offenders.push(`${file} -> ${spec.source} ${spec.imported ?? spec.kind}`);
      }
    }
    assert.deepEqual(offenders, []);
  });

  it("dispatchChain은 모든 제공자 호출 직전에 관문의 prepare를 거친다", () => {
    const calls    = SCANS.get("lib/llm/index.js").calls.filter(c => c.scope.includes("dispatchChain"));
    const invokes  = calls.filter(c => c.method === "callJson");
    const prepares = calls.filter(c => c.callee === "egress.prepare");
    assert.ok(invokes.length > 0, "dispatchChain에 제공자 호출이 있어야 한다");
    assert.equal(prepares.length, invokes.length);
    for (const call of invokes) {
      assert.deepEqual(call.args[0], { kind: "member", object: "sent", property: "prompt" }, `index.js:${call.line}`);
      assert.deepEqual(call.args[1], { kind: "member", object: "sent", property: "options" }, `index.js:${call.line}`);
    }
  });

  it("관문의 prepare는 판정 확인(assertEgressAllowed)을 부른다", () => {
    const calls = SCANS.get("lib/llm/EgressGate.js").calls.filter(c => c.scope.includes("prepare"));
    assert.ok(calls.some(c => c.callee === "assertEgressAllowed"));
  });

  it("llmJson은 관문을 열고 거른 체인을 넘긴다", () => {
    const calls = SCANS.get("lib/llm/index.js").calls.filter(c => c.scope.includes("llmJson"));
    assert.ok(calls.some(c => c.callee === "openEgressGate"));
    assert.ok(calls.some(c => c.callee === "egress.filter"));
    const dispatch = calls.find(c => c.callee === "dispatchChain");
    assert.ok(dispatch, "llmJson은 dispatchChain을 부른다");
    assert.ok(dispatch.args[3].kind === "object" && dispatch.args[3].keys.includes("egress"));
  });

  it("LLM 진입점 호출은 모두 egress 문맥을 싣고 등록된 단계 이름을 쓴다", () => {
    const offenders = [];
    const callers   = [];
    for (const [file, scan] of SCANS) {
      if (Object.hasOwn(ENTRY_MODULES, file)) continue;
      const names = entryNames(file);
      if (names.size === 0) continue;
      const entryCalls = scan.calls.filter(c => names.has(c.callee));
      if (entryCalls.length === 0) continue;
      callers.push(file);
      for (const call of entryCalls) {
        const opts = call.args[1];
        if (!(opts?.kind === "object" && opts.keys.includes("egress"))) offenders.push(`${file}:${call.line} ${call.callee}`);
      }
      const text   = readFileSync(path.join(ROOT, file), "utf8");
      const stages = [...text.matchAll(/\bstage\s*:\s*"([^"]+)"/g)].map(m => m[1]);
      if (stages.length === 0) offenders.push(`${file}: 단계 이름 없음`);
      for (const stage of stages) {
        if (!EGRESS_STAGES.includes(stage)) offenders.push(`${file}: 등록되지 않은 단계 ${stage}`);
      }
    }
    assert.deepEqual(offenders, []);
    for (const expected of [
      "lib/memory/link/ContradictionDetector.js",
      "lib/memory/processors/AutoReflect.js",
      "lib/memory/signals/MemoryEvaluator.js",
      "lib/memory/consolidate/ConsolidatorGC.js",
      "lib/memory/embedding/SyntheticQueryGenerator.js",
      "lib/memory/embedding/MorphemeIndex.js"
    ]) {
      assert.ok(callers.includes(expected), `${expected}는 LLM 진입점 호출 모듈로 인식되어야 한다`);
    }
  });
});
