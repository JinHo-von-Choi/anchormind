/**
 * 환경 변수 직접 접근 구조 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-05
 *
 * 중앙 모듈 밖에서 process.env를 읽는 지점이 config/env-access.js 대장에 사유와 함께 등록돼 있는지,
 * 대장의 분류(startup, runtime, cli)가 코드에서 판정한 값과 같은지 본다.
 * 허용 목록을 늘려 통과시키는 대신 등록되지 않은 접근을 실패로 만든다.
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";
import fs               from "node:fs";
import path             from "node:path";
import { fileURLToPath } from "node:url";

import { scanTree, scanSource, kindOf, findViolations } from "../../scripts/env-access-report.mjs";
import { ENV_ACCESS, CENTRAL_MODULES }                  from "../../config/env-access.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const KINDS = new Set(["startup", "runtime", "cli"]);

const refsOf = (rel, source) => scanSource(rel, source);

describe("환경 변수 접근 대장과 코드의 일치", () => {
  it("등록되지 않았거나 코드에 없거나 분류가 어긋난 접근이 없다", () => {
    assert.deepEqual(findViolations(scanTree()), []);
  });

  it("대장의 모든 항목이 분류, 변수, 사유를 갖추고 파일이 실제로 있다", () => {
    for (const entry of ENV_ACCESS) {
      assert.ok(KINDS.has(entry.kind), `${entry.file}: 알 수 없는 분류 ${entry.kind}`);
      assert.ok(entry.vars.length > 0, `${entry.file}: 변수가 없다`);
      assert.ok(typeof entry.reason === "string" && entry.reason.trim().length >= 10, `${entry.file}: 사유가 없다`);
      assert.ok(fs.existsSync(path.join(ROOT, entry.file)), `${entry.file}: 파일이 없다`);
    }
  });

  it("같은 파일, 분류, 변수가 대장에 두 번 나오지 않는다", () => {
    const seen = new Set();
    for (const entry of ENV_ACCESS) {
      for (const name of entry.vars) {
        const key = `${entry.file}|${entry.kind}|${name}`;
        assert.ok(!seen.has(key), `중복 등록: ${key}`);
        seen.add(key);
      }
    }
  });

  it("중앙 모듈은 대장에 등록하지 않는다", () => {
    for (const entry of ENV_ACCESS) {
      assert.ok(!CENTRAL_MODULES.includes(entry.file) && !entry.file.startsWith("config/"), `${entry.file}은 중앙 모듈이다`);
    }
  });
});

describe("접근 판정", () => {
  it("모듈 최상위의 읽기는 startup, 함수 안의 읽기는 runtime이다", () => {
    const refs = refsOf("lib/x.js", [
      "const TOP = process.env.TOP_VALUE;",
      "export function read() { return process.env.INSIDE_VALUE; }",
      "export const arrow = () => process.env.ARROW_VALUE;"
    ].join("\n"));
    const scope = Object.fromEntries(refs.map((r) => [r.name, r.scope]));
    assert.deepEqual(scope, { TOP_VALUE: "startup", INSIDE_VALUE: "runtime", ARROW_VALUE: "runtime" });
  });

  it("대괄호 표기와 도우미에 변수 이름을 넘기는 형태도 이름을 찾는다", () => {
    const refs = refsOf("lib/x.js", [
      "export function a() { return process.env[\"BRACKET_NAME\"]; }",
      "export function b() { return isLiteralTrue(process.env, \"HELPER_NAME\"); }"
    ].join("\n"));
    assert.deepEqual(refs.map((r) => r.name).sort(), ["BRACKET_NAME", "HELPER_NAME"]);
  });

  it("환경을 통째로 넘기거나 동적 이름으로 읽으면 따로 표시한다", () => {
    const refs = refsOf("lib/x.js", [
      "export function a() { return readMode(process.env); }",
      "export function b(name) { return process.env[name]; }"
    ].join("\n"));
    assert.deepEqual(refs.map((r) => r.name).sort(), ["(dynamic)", "(env)"]);
  });

  it("인자 기본값의 process.env는 함수 안으로 본다", () => {
    const refs = refsOf("lib/x.js", "export function build(env = process.env) { return env; }");
    assert.equal(refs[0].scope, "runtime");
  });

  it("lib/cli와 bin의 접근은 구문과 무관하게 cli다", () => {
    const refs = [...refsOf("lib/cli/x.js", "const A = process.env.A_VALUE;"), ...refsOf("bin/y.js", "export function f() { return process.env.B_VALUE; }")];
    assert.deepEqual(refs.map(kindOf), ["cli", "cli"]);
  });

  it("문자열이나 주석 안의 process.env는 접근으로 세지 않는다", () => {
    const refs = refsOf("lib/x.js", "// process.env.COMMENT_ONLY\nconst s = 'process.env.IN_STRING';");
    assert.deepEqual(refs, []);
  });
});

describe("대장 검사의 변형 시험", () => {
  const registry = [{ file: "lib/x.js", kind: "runtime", vars: ["KNOWN"], reason: "시험용 항목이다." }];

  it("등록된 접근만 있으면 위반이 없다", () => {
    const refs = refsOf("lib/x.js", "export function f() { return process.env.KNOWN; }");
    assert.deepEqual(findViolations(refs, registry), []);
  });

  it("등록되지 않은 변수를 읽으면 잡힌다", () => {
    const refs = refsOf("lib/x.js", "export function f() { return process.env.KNOWN + process.env.NEW_ONE; }");
    const violations = findViolations(refs, registry);
    assert.equal(violations.length, 1);
    assert.match(violations[0], /등록되지 않은 접근: lib\/x\.js:\d+ NEW_ONE/);
  });

  it("등록되지 않은 새 파일의 접근도 잡힌다", () => {
    const refs = refsOf("lib/other.js", "export const v = () => process.env.KNOWN;");
    assert.equal(findViolations(refs, registry).length, 2, "새 파일의 접근과 코드에 없는 기존 등록");
  });

  it("코드에서 사라진 변수가 대장에 남아 있으면 잡힌다", () => {
    const violations = findViolations(refsOf("lib/x.js", "export const v = 1;"), registry);
    assert.equal(violations.length, 1);
    assert.match(violations[0], /코드에 없는 등록: lib\/x\.js KNOWN/);
  });

  it("runtime을 startup으로 옮기면 분류 불일치로 잡힌다", () => {
    const refs = refsOf("lib/x.js", "const KNOWN = process.env.KNOWN;");
    const violations = findViolations(refs, registry);
    assert.equal(violations.length, 2, "startup 접근이 등록되지 않았고 runtime 등록은 코드에 없다");
    assert.ok(violations.some((v) => v.includes("(startup)")));
  });

  it("중앙 모듈의 읽기는 대장 없이 허용된다", () => {
    const refs = [
      ...refsOf("lib/config.js", "export const A = process.env.CENTRAL_A;"),
      ...refsOf("config/memory.js", "export const B = process.env.CENTRAL_B;")
    ];
    assert.deepEqual(findViolations(refs, []), []);
  });
});
