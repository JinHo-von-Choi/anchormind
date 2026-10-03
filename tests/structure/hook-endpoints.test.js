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
 *      동적 import는 별칭(const { tool_reflect: r } = await import(...))과 멤버 접근까지 원래 이름으로 보고,
 *      ../tools/memory.js에서는 tool_context만 꺼낼 수 있다.
 *   2. 요청 처리기는 lib/outbox/Outbox.js의 enqueueAutocommit으로만 기록한다.
 *   3. hook.reflect topic 처리기 등록은 lib/hooks/hook-reflect-consumer.js에만 있다.
 *   4. server.js는 /hooks/ 경로를 handleHookPost에만 넘긴다.
 *
 * 규칙 함수는 합성 소스로 위반을 잡는지 함께 확인한다.
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";
import { readFileSync } from "node:fs";
import path             from "node:path";
import { Linter }       from "eslint";

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

/**
 * 동적 import로 꺼내는 이름. `const { a: b } = await import(x)`의 키 a와 `(await import(x)).a`의 a를
 * { source, name }으로 모은다. 별칭을 붙여도 원래 이름이 남는다.
 *
 * @param {string} source
 * @returns {Array<{ source: string|null, name: string }>}
 */
function dynamicImportNames(source) {
  const found = [];
  const importOf = (node) => {
    let n = node;
    while (n && (n.type === "AwaitExpression" || n.type === "ChainExpression")) n = n.argument ?? n.expression;
    return n?.type === "ImportExpression" ? n : null;
  };
  const sourceOf = (imp) => (imp.source.type === "Literal" ? imp.source.value : null);
  const rule = {
    create() {
      return {
        VariableDeclarator(node) {
          const imp = importOf(node.init);
          if (!imp || node.id.type !== "ObjectPattern") return;
          for (const prop of node.id.properties) {
            if (prop.type === "Property") found.push({ source: sourceOf(imp), name: prop.key.name ?? prop.key.value });
          }
        },
        MemberExpression(node) {
          const imp = importOf(node.object);
          if (imp && !node.computed) found.push({ source: sourceOf(imp), name: node.property.name });
        }
      };
    }
  };
  const messages = new Linter().verify(source, [{
    plugins        : { probe: { rules: { names: rule } } },
    rules          : { "probe/names": "error" },
    languageOptions: { ecmaVersion: "latest", sourceType: "module" }
  }]);
  const fatal = messages.find(m => m.fatal);
  if (fatal) throw new Error(`parse failed: ${fatal.message}`);
  return found;
}

/**
 * 동적 import 규칙 위반. 이름이 금지 목록에 있거나, ../tools/memory.js에서 tool_context 밖의 이름을 꺼내면 위반이다.
 *
 * @param {string} source
 * @returns {string[]}
 */
function dynamicImportViolations(source) {
  return dynamicImportNames(source)
    .filter(({ source: from, name }) => FORBIDDEN_NAMES.test(name)
      || (typeof from === "string" && /tools\/memory\.js$/.test(from) && name !== "tool_context"))
    .map(({ source: from, name }) => `dynamic ${from}:${name}`);
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

  it("동적 import로 회고 함수를 꺼내지 않는다(별칭 포함)", () => {
    assert.deepEqual(dynamicImportViolations(readFileSync(path.join(ROOT, HANDLER), "utf8")), []);
  });

  it("outbox 기록은 enqueueAutocommit 하나이고 실제로 부른다", () => {
    const imported = outboxImports(scan).filter(name => name.startsWith("enqueue"));
    assert.deepEqual(imported, ["enqueueAutocommit"]);
    assert.ok(scan.calls.some(call => call.callee === "enqueueAutocommit"), "enqueueAutocommit 호출이 없다");
  });

  it("동적 import 규칙이 별칭과 멤버 접근 형태의 합성 위반을 잡는다", () => {
    const found = dynamicImportViolations(`
      export async function a() { const { tool_reflect: r } = await import("../tools/memory.js"); return r; }
      export async function b() { return (await import("../tools/memory.js")).tool_reflect; }
      export async function c() { const { autoReflect } = await import("../memory/processors/AutoReflect.js"); return autoReflect; }
      export async function d() { const { tool_context } = await import("../tools/memory.js"); return tool_context; }
      export async function e() { const { tool_remember: x } = await import("../tools/memory.js"); return x; }`);
    assert.deepEqual(found.sort(), [
      "dynamic ../memory/processors/AutoReflect.js:autoReflect",
      "dynamic ../tools/memory.js:tool_reflect",
      "dynamic ../tools/memory.js:tool_reflect",
      "dynamic ../tools/memory.js:tool_remember"
    ]);
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
