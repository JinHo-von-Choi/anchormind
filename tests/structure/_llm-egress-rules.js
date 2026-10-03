/**
 * LLM 외부 전송 경로 구조 규칙
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 소스 묶음(저장소 기준 상대 경로 → 소스 문자열)을 받아 규칙별 위반 목록을 돌려준다. 저장소 전체에 대한
 * 검사(llm-egress.test.js)와 소스 사본에 위반을 넣어 규칙이 잡는지 보는 변이 검사(llm-egress-mutation.test.js)가
 * 같은 함수를 쓴다.
 *
 * 규칙
 *   providerCalls     제공자 호출(callJson, callText)은 lib/llm/index.js, LlmProvider.js, providers/ 안에만 있다.
 *   providerImports   제공자 모듈은 lib/llm 안에서만 가져온다. registry.js는 lib/llm 밖에서 listProviderNames만 가져온다.
 *   runnerImports     CLI 실행 함수(run*CLI)는 lib/llm/providers/에서만 가져오거나 다시 내보낸다.
 *   dispatchImports   dispatchChain은 lib/llm/index.js 밖에서 가져오거나 다시 내보내지 않는다(관문 없이 체인을 부르는 길).
 *   namespaceImports  진입 모듈(lib/llm/index.js, lib/gemini.js, lib/qwen.js)과 CLI 모듈은 lib/llm 밖에서
 *                     이름공간(import * as, export *)으로 가져오지 않는다.
 *   dynamicImports    진입 모듈과 CLI 모듈의 동적 import는 DYNAMIC_IMPORT_ALLOW의 파일에서만, 구조 분해로
 *                     DYNAMIC_IMPORT_NAMES의 이름만 꺼낸다.
 *   gateInDispatch    dispatchChain의 모든 callJson은 egress.prepare가 돌려준 sent.prompt, sent.options를 넘기고
 *                     prepare 호출 수가 callJson 호출 수와 같다. 관문의 prepare는 assertEgressAllowed를 부른다.
 *   gateInLlmJson     llmJson은 openEgressGate로 관문을 열고 egress.filter로 거른 체인을 dispatchChain에 egress와 넘긴다.
 *   callerContext     진입 함수(llmJson, geminiCLIJson, qwenCLIJson과 별칭)를 부르는 곳은 옵션 객체 리터럴에 egress를
 *                     싣고, 그 파일의 단계 이름은 모두 KNOWN_STAGES에 있다.
 */

import path from "node:path";

import { scanSource }   from "./_source-scan.js";
import { KNOWN_STAGES } from "../../lib/llm/EgressPolicy.js";

/** LLM JSON 진입 함수와 그 모듈 */
export const ENTRY_MODULES = Object.freeze({
  "lib/llm/index.js": "llmJson",
  "lib/gemini.js"   : "geminiCLIJson",
  "lib/qwen.js"     : "qwenCLIJson"
});

/** CLI 실행 함수(run*CLI)를 내보내는 모듈 */
export const CLI_MODULES = Object.freeze([
  "lib/gemini.js", "lib/codex.js", "lib/qwen.js", "lib/agy.js", "lib/copilot.js", "lib/opencode.js"
]);

/** 진입 모듈과 CLI 모듈 */
const WATCHED_MODULES = new Set([...Object.keys(ENTRY_MODULES), ...CLI_MODULES]);

/** 동적 import로 진입 모듈을 가져와도 되는 파일과 그 이유 */
export const DYNAMIC_IMPORT_ALLOW = Object.freeze({
  "lib/gemini.js"                                : "llmJson, isLlmAvailable 위임 shim. 정적 import는 순환을 만든다",
  "lib/qwen.js"                                  : "llmJson, isLlmAvailable 위임 shim. 정적 import는 순환을 만든다",
  "lib/codex.js"                                 : "isLlmAvailable 위임 shim",
  "lib/agy.js"                                   : "isLlmAvailable 위임 shim",
  "lib/copilot.js"                               : "isLlmAvailable 위임 shim",
  "lib/opencode.js"                              : "isLlmAvailable 위임 shim",
  "lib/memory/embedding/MorphemeIndex.js"        : "LLM 형태소 경로(MEMENTO_MORPHEME_TOKENIZER=llm)에서만 gemini.js를 불러온다",
  "lib/memory/embedding/SyntheticQueryGenerator.js": "remember 후처리 경로가 LLM 스택 전체를 기동 시 불러오지 않게 지연 로드한다"
});

/** 동적 import 구조 분해로 꺼낼 수 있는 이름 */
export const DYNAMIC_IMPORT_NAMES = Object.freeze(["llmJson", "isLlmAvailable", "geminiCLIJson", "isGeminiCLIAvailable"]);

const RUNNER_NAME = /^run\w*CLI$/;

/** import 경로를 저장소 기준 상대 경로로 푼다. 상대 경로가 아니면 null. */
export function resolveImport(file, source) {
  if (typeof source !== "string" || !source.startsWith(".")) return null;
  return path.posix.normalize(path.posix.join(path.posix.dirname(file), source));
}

const PROVIDER_CALL_FILE = (file) =>
  file === "lib/llm/index.js" || file === "lib/llm/LlmProvider.js" || file.startsWith("lib/llm/providers/");

/** 파일이 진입 함수를 부를 때 쓰는 이름(정적 named import 지역 이름, 동적 import 구조 분해 이름과 별칭) */
function entryNames(file, scan, text) {
  const names = new Set();
  for (const spec of scan.importSpecs) {
    const target = resolveImport(file, spec.source);
    if (spec.kind === "named" && target && ENTRY_MODULES[target] === spec.imported) names.add(spec.local);
  }
  for (const binding of dynamicBindings(file, text)) {
    if (Object.values(ENTRY_MODULES).includes(binding.imported)) names.add(binding.local);
  }
  return names;
}

/**
 * 감시 모듈의 동적 import 위치와 구조 분해 이름. 구조 분해가 아니면 names가 null이다.
 *
 * @returns {Array<{ target: string, names: Array<{ imported: string, local: string }>|null, index: number }>}
 */
function dynamicImportSites(file, text) {
  const sites = [];
  for (const m of text.matchAll(/import\(\s*(["'`])([^"'`]+)\1\s*\)/g)) {
    const target = resolveImport(file, m[2]);
    if (!target || !WATCHED_MODULES.has(target)) continue;
    const before = text.slice(Math.max(0, m.index - 200), m.index);
    const pattern = /\{([^{}]*)\}\s*=\s*await\s*$/;
    const found   = pattern.exec(before);
    const names   = found
      ? found[1].split(",").map((part) => part.trim()).filter(Boolean).map((part) => {
        const [imported, local] = part.split(":").map((x) => x.trim());
        return { imported, local: local ?? imported };
      })
      : null;
    sites.push({ target, names, index: m.index });
  }
  return sites;
}

function dynamicBindings(file, text) {
  return dynamicImportSites(file, text).flatMap((site) => site.names ?? []);
}

/** 줄 번호 */
function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

/**
 * 규칙을 검사한다.
 *
 * @param {Map<string, string>} sources - 저장소 기준 상대 경로 → 소스
 * @returns {Record<string, string[]>} 규칙별 위반
 */
export function checkEgressStructure(sources) {
  const out = {
    providerCalls: [], providerImports: [], runnerImports: [], dispatchImports: [], namespaceImports: [],
    dynamicImports: [], gateInDispatch: [], gateInLlmJson: [], callerContext: []
  };
  const scans = new Map([...sources].map(([file, text]) => [file, scanSource(text)]));

  for (const [file, scan] of scans) {
    const text   = sources.get(file);
    const inLlm  = file.startsWith("lib/llm/");

    if (!PROVIDER_CALL_FILE(file)) {
      for (const call of scan.calls) {
        if (call.method === "callJson" || call.method === "callText") out.providerCalls.push(`${file}:${call.line} ${call.callee}`);
      }
    }

    for (const spec of scan.importSpecs) {
      const target = resolveImport(file, spec.source);
      if (!target) continue;
      const label = `${file} -> ${spec.source} ${spec.imported ?? spec.kind}`;

      if (!inLlm && target.startsWith("lib/llm/providers/")) out.providerImports.push(label);
      if (!inLlm && target === "lib/llm/registry.js" && !(spec.kind === "named" && spec.imported === "listProviderNames")) {
        out.providerImports.push(label);
      }
      if (CLI_MODULES.includes(target) && !file.startsWith("lib/llm/providers/")
          && (spec.kind === "named" || spec.kind === "reexport") && RUNNER_NAME.test(spec.imported ?? "")) {
        out.runnerImports.push(label);
      }
      if (target === "lib/llm/index.js" && file !== "lib/llm/index.js"
          && (spec.kind === "named" || spec.kind === "reexport") && spec.imported === "dispatchChain") {
        out.dispatchImports.push(label);
      }
      if (!inLlm && WATCHED_MODULES.has(target) && spec.kind === "namespace") {
        const allowedProvider = file.startsWith("lib/llm/providers/");
        if (!allowedProvider) out.namespaceImports.push(label);
      }
    }

    for (const site of dynamicImportSites(file, text)) {
      const where = `${file}:${lineOf(text, site.index)} -> ${site.target}`;
      if (!Object.hasOwn(DYNAMIC_IMPORT_ALLOW, file)) {
        out.dynamicImports.push(`${where} (허용 목록 밖)`);
        continue;
      }
      if (site.names === null) {
        out.dynamicImports.push(`${where} (구조 분해가 아님)`);
        continue;
      }
      for (const { imported } of site.names) {
        if (!DYNAMIC_IMPORT_NAMES.includes(imported)) out.dynamicImports.push(`${where} (${imported})`);
      }
    }
  }

  checkGate(scans, out);
  checkCallers(sources, scans, out);
  return out;
}

/** 관문 배선 규칙 */
function checkGate(scans, out) {
  const index = scans.get("lib/llm/index.js");
  const gate  = scans.get("lib/llm/EgressGate.js");
  if (!index || !gate) {
    out.gateInDispatch.push("lib/llm/index.js 또는 lib/llm/EgressGate.js 없음");
    return;
  }
  const dispatchCalls = index.calls.filter(c => c.scope.includes("dispatchChain"));
  const invokes       = dispatchCalls.filter(c => c.method === "callJson");
  const prepares      = dispatchCalls.filter(c => c.callee === "egress.prepare");
  if (invokes.length === 0) out.gateInDispatch.push("dispatchChain에 제공자 호출 없음");
  if (prepares.length !== invokes.length) out.gateInDispatch.push(`prepare ${prepares.length}건, callJson ${invokes.length}건`);
  for (const call of invokes) {
    const [first, second] = call.args;
    const ok = first?.kind === "member" && first.object === "sent" && first.property === "prompt"
            && second?.kind === "member" && second.object === "sent" && second.property === "options";
    if (!ok) out.gateInDispatch.push(`index.js:${call.line} callJson 인자가 sent.prompt, sent.options가 아님`);
  }
  if (!gate.calls.some(c => c.scope.includes("prepare") && c.callee === "assertEgressAllowed")) {
    out.gateInDispatch.push("EgressGate.prepare가 assertEgressAllowed를 부르지 않음");
  }

  const llmCalls = index.calls.filter(c => c.scope.includes("llmJson"));
  if (!llmCalls.some(c => c.callee === "openEgressGate")) out.gateInLlmJson.push("openEgressGate 호출 없음");
  if (!llmCalls.some(c => c.callee === "egress.filter"))  out.gateInLlmJson.push("egress.filter 호출 없음");
  const dispatch = llmCalls.find(c => c.callee === "dispatchChain");
  if (!dispatch) out.gateInLlmJson.push("dispatchChain 호출 없음");
  else if (!(dispatch.args[3]?.kind === "object" && dispatch.args[3].keys.includes("egress"))) {
    out.gateInLlmJson.push("dispatchChain에 egress를 넘기지 않음");
  }
}

/** 호출자 문맥 규칙. 진입 함수를 부르는 파일 목록을 out.callers에 담는다. */
function checkCallers(sources, scans, out) {
  out.callers = [];
  for (const [file, scan] of scans) {
    if (Object.hasOwn(ENTRY_MODULES, file)) continue;
    const text  = sources.get(file);
    const names = entryNames(file, scan, text);
    if (names.size === 0) continue;
    const entryCalls = scan.calls.filter(c => names.has(c.callee));
    if (entryCalls.length === 0) continue;
    out.callers.push(file);
    for (const call of entryCalls) {
      const opts = call.args[1];
      if (!(opts?.kind === "object" && opts.keys.includes("egress"))) out.callerContext.push(`${file}:${call.line} ${call.callee}`);
    }
    const stages = [...text.matchAll(/\bstage\s*:\s*"([^"]+)"/g)].map(m => m[1]);
    if (stages.length === 0) out.callerContext.push(`${file}: 단계 이름 없음`);
    for (const stage of stages) {
      if (!Object.hasOwn(KNOWN_STAGES, stage)) out.callerContext.push(`${file}: 등록되지 않은 단계 ${stage}`);
    }
  }
}
