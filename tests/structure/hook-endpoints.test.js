/**
 * 훅 엔드포인트 구조 검사
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 회고는 요청 경로에서 수행하지 않고 outbox를 거친다. 소스를 정적으로 읽어 다음을 본다.
 *
 *   1. 요청 처리기(lib/handlers/hook-handler.js)는 회고 모듈(MemoryManager, MemoryReflector, ReflectProcessor,
 *      AutoReflect, 회고 소비자, 멱등 선점 저장소)을 정적으로도 동적으로도 불러오지 않고, 이름에 reflect가 든
 *      함수를 부르지 않는다.
 *   2. 요청 처리기는 lib/outbox/Outbox.js의 enqueueStandalone으로만 기록한다.
 *   3. hook.reflect topic 처리기 등록은 lib/hooks/hook-reflect-consumer.js에만 있다.
 *   4. server.js는 /hooks/ 경로를 handleHookPost에만 넘긴다.
 *
 * 규칙 함수는 합성 소스로 위반을 잡는지 함께 확인한다.
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";
import { readFileSync } from "node:fs";
import path             from "node:path";

import { ROOT, listSourceFiles, scanFile, scanSource } from "./_source-scan.js";

const HANDLER  = "lib/handlers/hook-handler.js";
const CONSUMER = "lib/hooks/hook-reflect-consumer.js";

/** 요청 경로가 불러오면 안 되는 모듈 이름 */
const FORBIDDEN_MODULES = /(?:^|\/)(?:MemoryManager|MemoryReflector|ReflectProcessor|AutoReflect|hook-reflect-consumer|IdempotencyStore)\.js$/;

/** 요청 경로가 가져오면 안 되는 이름 */
const FORBIDDEN_NAMES = /^(?:tool_reflect|autoReflect|MemoryManager|MemoryReflector|ReflectProcessor|createHookReflectHandler|registerHookReflectConsumer)$/;

/** 회고를 수행하는 호출: reflect 메서드, 회고 함수와 처리기 */
const FORBIDDEN_CALLS = /(?:^|\.)(?:reflect|tool_reflect|autoReflect|process)$|ReflectProcessor|hookReflectHandler/;

/**
 * 요청 처리기 소스의 규칙 위반 목록
 *
 * @param {ReturnType<typeof scanSource>} scan
 * @returns {string[]}
 */
function requestPathViolations(scan) {
  const out = [];
  for (const spec of scan.importSpecs) {
    if (spec.source && FORBIDDEN_MODULES.test(spec.source)) out.push(`import ${spec.source}`);
    if (spec.imported && FORBIDDEN_NAMES.test(spec.imported)) out.push(`import name ${spec.imported}`);
  }
  for (const call of scan.calls) {
    if (FORBIDDEN_CALLS.test(call.callee)) out.push(`call ${call.callee}`);
  }
  for (const s of scan.strings) {
    if (/\btool_reflect\b/.test(s.text)) out.push("string tool_reflect");
  }
  return out;
}

/** 파일이 Outbox.js에서 named import한 이름 */
function outboxImports(scan) {
  return scan.importSpecs
    .filter(spec => spec.source === "../outbox/Outbox.js" && spec.kind === "named")
    .map(spec => spec.imported);
}

describe("훅 요청 경로", () => {
  const scan = scanFile(HANDLER);

  it("회고 모듈을 불러오거나 회고 함수를 부르지 않는다", () => {
    assert.deepEqual(requestPathViolations(scan), []);
  });

  it("outbox 기록은 enqueueStandalone 하나이고 실제로 부른다", () => {
    const imported = outboxImports(scan).filter(name => name.startsWith("enqueue"));
    assert.deepEqual(imported, ["enqueueStandalone"]);
    assert.ok(scan.calls.some(call => call.callee === "enqueueStandalone"), "enqueueStandalone 호출이 없다");
  });

  it("규칙이 합성 위반을 잡는다", () => {
    const bad = scanSource(`
      import { MemoryManager } from "../memory/MemoryManager.js";
      import { tool_reflect } from "../tools/memory.js";
      export async function h(a) {
        await import("../hooks/hook-reflect-consumer.js");
        await MemoryManager.getInstance().reflect(a);
        return "tool_reflect";
      }`);
    const found = requestPathViolations(bad);
    for (const expected of ["import ../memory/MemoryManager.js", "import name tool_reflect",
      "import ../hooks/hook-reflect-consumer.js", "call MemoryManager.getInstance().reflect", "string tool_reflect"]) {
      assert.ok(found.includes(expected), `${expected} 미검출: ${found.join(", ")}`);
    }
  });
});

describe("hook.reflect 처리기 등록", () => {
  it("registerOutboxHandler로 hook.reflect를 등록하는 모듈은 회고 소비자 하나다", () => {
    const registrants = listSourceFiles("lib").filter((file) => {
      const scan = scanFile(file);
      return scan.calls.some(call => call.callee === "registerOutboxHandler"
        && (call.args[0]?.kind === "identifier" && call.args[0].name === "HOOK_REFLECT_TOPIC"
            || readFileSync(path.join(ROOT, file), "utf8").includes("\"hook.reflect\"")));
    });
    assert.deepEqual(registrants, [CONSUMER]);
  });

  it("회고 소비자는 요청 처리기를 불러오지 않는다", () => {
    assert.ok(!scanFile(CONSUMER).imports.some(source => /hook-handler\.js$/.test(source)));
  });
});

describe("server.js 경로", () => {
  it("/hooks/ 경로는 handleHookPost로만 넘긴다", () => {
    const src   = readFileSync(path.join(ROOT, "server.js"), "utf8");
    const block = src.match(/url\.pathname\.startsWith\("\/hooks\/"\)\)\s*\{([\s\S]*?)\n {2}\}/);
    assert.ok(block, "server.js에 /hooks/ 분기가 없다");
    const calls = [...block[1].matchAll(/await\s+([A-Za-z_]+)\(/g)].map(m => m[1]);
    assert.deepEqual(calls, ["handleHookPost"]);
  });
});
