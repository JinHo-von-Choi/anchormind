/**
 * LLM 외부 전송 구조 규칙의 변이 검사
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 저장소 소스의 메모리 사본에 관문을 거치지 않는 경로 하나를 넣고, 규칙(_llm-egress-rules.js)이 그 경로를 맞는 규칙 이름으로
 * 잡는지 본다. 사본은 시험마다 새로 만들며 저장소 파일은 건드리지 않는다.
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";
import { readFileSync } from "node:fs";
import path             from "node:path";

import { listSourceFiles, ROOT } from "./_source-scan.js";
import { checkEgressStructure }  from "./_llm-egress-rules.js";

const BASE = new Map(
  [...listSourceFiles("lib"), ...listSourceFiles("scripts"), ...listSourceFiles("bin")]
    .map(file => [file, readFileSync(path.join(ROOT, file), "utf8")])
);

/** 사본에 파일을 더하거나 바꾼 뒤 규칙 결과를 돌려준다. */
function mutate(changes) {
  const copy = new Map(BASE);
  for (const [file, edit] of Object.entries(changes)) {
    copy.set(file, typeof edit === "function" ? edit(copy.get(file)) : edit);
  }
  return checkEgressStructure(copy);
}

/** 한 군데만 바꾸는 치환. 바꿀 문자열이 없으면 시험이 실패한다. */
function replaceOnce(from, to) {
  return (text) => {
    assert.ok(text.includes(from), `치환 대상 없음: ${from}`);
    return text.replace(from, to);
  };
}

const LEAK = "lib/memory/leak/Leak.js";

describe("기준 사본", () => {
  it("변이 없는 사본은 위반이 없다", () => {
    const result = checkEgressStructure(new Map(BASE));
    for (const [rule, list] of Object.entries(result)) {
      if (rule !== "callers") assert.deepEqual(list, [], rule);
    }
  });
});

describe("변이마다 규칙이 잡는다", () => {
  const cases = [
    ["CLI 실행 함수 직접 호출(gemini)", "runnerImports",
      { [LEAK]: `import { runGeminiCLI } from "../../gemini.js";\nexport const f = (t) => runGeminiCLI("", t);\n` }],
    ["CLI 실행 함수 직접 호출(codex, 별칭)", "runnerImports",
      { [LEAK]: `import { runCodexCLI as go } from "../../codex.js";\nexport const f = (t) => go("", t);\n` }],
    ["CLI 실행 함수 직접 호출(qwen, agy, copilot, opencode)", "runnerImports",
      { [LEAK]: [
        `import { runQwenCLI } from "../../qwen.js";`, `import { runAgyCLI } from "../../agy.js";`,
        `import { runCopilotCLI } from "../../copilot.js";`, `import { runOpenCodeCLI } from "../../opencode.js";`,
        `export const f = (t) => [runQwenCLI("", t), runAgyCLI("", t), runCopilotCLI(t), runOpenCodeCLI(t)];`
      ].join("\n") }],
    ["CLI 실행 함수 다시 내보내기", "runnerImports",
      { [LEAK]: `export { runCodexCLI } from "../../codex.js";\n` }],
    ["진입 모듈 이름공간 import", "namespaceImports",
      { [LEAK]: `import * as llm from "../../llm/index.js";\nexport const f = (t) => llm.llmJson(t, {});\n` }],
    ["CLI 모듈 이름공간 import", "namespaceImports",
      { [LEAK]: `import * as g from "../../gemini.js";\nexport const f = (t) => g.runGeminiCLI("", t);\n` }],
    ["진입 모듈 전부 다시 내보내기", "namespaceImports",
      { [LEAK]: `export * from "../../gemini.js";\n` }],
    ["허용 목록 밖의 동적 import(이름공간)", "dynamicImports",
      { [LEAK]: `export async function f(t) {\n  const llm = await import("../../llm/index.js");\n  return llm.llmJson(t, {});\n}\n` }],
    ["허용 목록 밖의 동적 import(구조 분해)", "dynamicImports",
      { [LEAK]: `export async function f(t) {\n  const { llmJson } = await import("../../llm/index.js");\n  return llmJson(t, { egress: { stage: "split" } });\n}\n` }],
    ["허용 목록 밖의 템플릿 문자열 동적 import", "dynamicImports",
      { [LEAK]: "export async function f(t) {\n  const m = await import(`../../codex.js`);\n  return m.runCodexCLI(\"\", t);\n}\n" }],
    ["허용 파일의 동적 import를 이름공간으로 바꿈", "dynamicImports",
      { "lib/memory/embedding/MorphemeIndex.js": replaceOnce(
        `const { geminiCLIJson, isGeminiCLIAvailable } = await import("../../gemini.js");`,
        `const gemini = await import("../../gemini.js"); const { geminiCLIJson, isGeminiCLIAvailable } = gemini;`) }],
    ["허용 파일의 동적 import에서 실행 함수를 꺼냄", "dynamicImports",
      { "lib/memory/embedding/MorphemeIndex.js": replaceOnce(
        `const { geminiCLIJson, isGeminiCLIAvailable } = await import("../../gemini.js");`,
        `const { geminiCLIJson, isGeminiCLIAvailable, runGeminiCLI } = await import("../../gemini.js");`) }],
    ["dispatchChain 직접 import", "dispatchImports",
      { [LEAK]: `import { dispatchChain } from "../../llm/index.js";\nexport const f = (c, t) => dispatchChain(c, t, {});\n` }],
    ["dispatchChain 별칭 import", "dispatchImports",
      { [LEAK]: `import { dispatchChain as run } from "../../llm/index.js";\nexport const f = (c, t) => run(c, t);\n` }],
    ["dispatchChain 다시 내보내기", "dispatchImports",
      { [LEAK]: `export { dispatchChain } from "../../llm/index.js";\n` }],
    ["lib/llm 밖의 createProvider import", "providerImports",
      { [LEAK]: `import { createProvider } from "../../llm/registry.js";\nexport const p = createProvider("codex-cli");\n` }],
    ["lib/llm 밖의 제공자 모듈 import", "providerImports",
      { [LEAK]: `import { CodexCliProvider } from "../../llm/providers/CodexCliProvider.js";\nexport const p = new CodexCliProvider({});\n` }],
    ["lib/llm 밖의 제공자 호출", "providerCalls",
      { [LEAK]: `export const f = (p, t) => p.callJson(t, {});\n` }],
    ["진입 함수 호출에서 egress 문맥 빠짐", "callerContext",
      { "lib/memory/signals/MemoryEvaluator.js": replaceOnce(
        `egress      : { stage: "evaluate", keyId: target.key_id ?? null, workspace: target.workspace ?? null }`, `dummy: 1`) }],
    ["진입 함수 별칭 호출에서 egress 문맥 빠짐", "callerContext",
      { [LEAK]: `import { llmJson as ask } from "../../llm/index.js";\nexport const f = (t) => ask(t, { stage: "split" });\n` }],
    ["등록되지 않은 단계 이름", "callerContext",
      { [LEAK]: `import { llmJson } from "../../llm/index.js";\nexport const f = (t) => llmJson(t, { egress: { stage: "synthesis" } });\n` }],
    ["dispatchChain이 관문을 거치지 않은 프롬프트를 보냄", "gateInDispatch",
      { "lib/llm/index.js": replaceOnce("provider.callJson(sent.prompt, sent.options)", "provider.callJson(prompt, providerOptions)") }],
    ["관문의 prepare가 판정을 다시 확인하지 않음", "gateInDispatch",
      { "lib/llm/EgressGate.js": replaceOnce("assertEgressAllowed(input);", "void input;") }],
    ["llmJson이 dispatchChain에 관문을 넘기지 않음", "gateInLlmJson",
      { "lib/llm/index.js": replaceOnce("{ startedAt, egress });", "{ startedAt });") }],
    ["llmJson이 체인을 거르지 않음", "gateInLlmJson",
      { "lib/llm/index.js": replaceOnce("dispatchChain(egress.filter(chain),", "dispatchChain(chain,") }]
  ];

  for (const [name, rule, changes] of cases) {
    it(`${name} -> ${rule}`, () => {
      const result = mutate(changes);
      assert.ok(result[rule].length > 0, `${rule}가 잡지 못했다: ${JSON.stringify(result[rule])}`);
    });
  }
});
