/**
 * 프로토콜 개정 판정 구조 검사
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * MCP 2026-07-28 개정을 먼저 시도하는 클라이언트는 400 본문에 그 개정의 오류가 있으면 서버를
 * 현대식으로 판정하고 그 판정을 origin 단위로 캐시한다. 그 개정을 완결하지 않은 서버가 개정 전용
 * 응답을 하나라도 내면 클라이언트가 initialize 폴백을 하지 않게 되므로, 이 서버는 다음을 지킨다.
 *
 *   1. 개정이 예약한 오류 코드 구간(-32020~-32099, 정의된 코드는 -32020, -32021, -32022)의 수치를
 *      lib, bin, server.js 어디에도 두지 않는다.
 *   2. server/discover 메서드 이름을 처리 경로에 두지 않고, 디스패처는 그 요청을 -32601로 돌려준다.
 *
 * 정적 검사의 범위: 수치는 숫자 리터럴과 단항 +, -, 이항 +, -, *만으로 된 식을 접어서 본다
 * (-(32020), -(32000 + 20), -32000 - 20). 문자열은 리터럴의 + 연결, 템플릿, 같은 파일의 문자열
 * 상수 보간을 펼쳐서 본다("server/" + "discover"). 다른 모듈의 상수, 함수 호출이나 배열 join으로
 * 만든 값은 정적으로 보지 않으며, 메서드 이름은 디스패처 행동 시험이 실행 시점에 확인한다.
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";
import { readFileSync } from "node:fs";
import path             from "node:path";
import { Linter }       from "eslint";

import { ROOT, listSourceFiles, scanFile, scanSource } from "./_source-scan.js";

process.env.DOTENV_CONFIG_PATH      ??= ".env.test";
process.env.MEMENTO_METRICS_DEFAULT ??= "off";
process.env.REDIS_ENABLED           ??= "false";
process.env.CACHE_ENABLED           ??= "false";

const SOURCES        = [...listSourceFiles("lib"), ...listSourceFiles("bin"), "server.js"];
const RESERVED_LOW   = -32099;
const RESERVED_HIGH  = -32020;
const DISCOVER       = "server/discover";

/** 수치가 개정 예약 구간에 드는지 */
function isReservedCode(value) {
  return Number.isInteger(value) && value >= RESERVED_LOW && value <= RESERVED_HIGH;
}

const FOLD_UNARY  = { "-": (a) => -a, "+": (a) => a };
const FOLD_BINARY = { "+": (a, b) => a + b, "-": (a, b) => a - b, "*": (a, b) => a * b };

/**
 * 숫자 리터럴과 단항 +, -, 이항 +, -, *만으로 된 식을 접는다. 그 밖이면 null.
 *
 * @param {object} node
 * @returns {number|null}
 */
function foldNumber(node) {
  if (node.type === "Literal") return typeof node.value === "number" ? node.value : null;
  if (node.type === "UnaryExpression" && FOLD_UNARY[node.operator]) {
    const a = foldNumber(node.argument);
    return a === null ? null : FOLD_UNARY[node.operator](a);
  }
  if (node.type === "BinaryExpression" && FOLD_BINARY[node.operator]) {
    const a = foldNumber(node.left);
    const b = a === null ? null : foldNumber(node.right);
    return b === null ? null : FOLD_BINARY[node.operator](a, b);
  }
  return null;
}

/**
 * 소스의 상수 수치 식(-N, -(N), -(N + M), -N - M 등)을 접은 값과 문자열 안의 -320NN 표기를 모은다.
 *
 * @param {string} source
 * @returns {Array<{ value: number, line: number }>}
 */
function negativeNumbers(source) {
  const found = [];
  const fold  = (node) => {
    const value = foldNumber(node);
    if (value !== null && value < 0) found.push({ value, line: node.loc.start.line });
  };
  const rule  = {
    create() {
      return {
        UnaryExpression : fold,
        BinaryExpression: fold,
        Literal(node) {
          if (typeof node.value !== "string") return;
          for (const m of node.value.matchAll(/-320\d\d\b/g)) found.push({ value: Number(m[0]), line: node.loc.start.line });
        }
      };
    }
  };
  const messages = new Linter().verify(source, [{
    plugins        : { probe: { rules: { numbers: rule } } },
    rules          : { "probe/numbers": "error" },
    languageOptions: { ecmaVersion: "latest", sourceType: "module" }
  }]);
  const fatal = messages.find(m => m.fatal);
  if (fatal) throw new Error(`parse failed: ${fatal.message}`);
  return found;
}

describe("개정 예약 오류 코드", () => {
  it("검사 대상에 핸들러, 디스패처, 서버 진입점이 들어 있다", () => {
    for (const f of ["lib/handlers/mcp-handler.js", "lib/handlers/sse-handler.js", "lib/jsonrpc.js", "server.js"]) {
      assert.ok(SOURCES.includes(f), f);
    }
  });

  it("lib, bin, server.js에 -32020~-32099 수치가 없다", () => {
    const hits = [];
    for (const rel of SOURCES) {
      const source = readFileSync(path.join(ROOT, rel), "utf8");
      for (const { value, line } of negativeNumbers(source)) {
        if (isReservedCode(value)) hits.push(`${rel}:${line} ${value}`);
      }
    }
    assert.deepEqual(hits, []);
  });

  it("수치 수집기는 리터럴과 문자열 표기를 모두 잡고 구간 밖은 거른다", () => {
    const sample = [
      "const a = -32020;",
      "const b = { code: -32022 };",
      "const c = \"code -32021\";",
      "const d = -32000;",
      "const e = -32601;",
      "const f = -(32023);",
      "const g = -(32000 + 24);",
      "const h = -32000 - 25;"
    ].join("\n");
    const values = negativeNumbers(sample).map(n => n.value);
    assert.deepEqual([...new Set(values.filter(isReservedCode))].sort((a, b) => a - b), [-32025, -32024, -32023, -32022, -32021, -32020]);
    assert.ok(values.includes(-32000) && !isReservedCode(-32000));
    assert.ok(values.includes(-32601) && !isReservedCode(-32601));
  });
});

describe("server/discover", () => {
  it("lib, bin, server.js의 문자열에 server/discover가 없다", () => {
    const hits = [];
    for (const rel of SOURCES) {
      for (const { text, line } of scanFile(rel).strings) {
        if (text.includes(DISCOVER)) hits.push(`${rel}:${line}`);
      }
    }
    assert.deepEqual(hits, []);
  });

  it("문자열 수집은 + 연결, 템플릿, 같은 파일 상수 보간을 펼쳐 server/discover를 찾는다", () => {
    const sample = [
      "const A = \"server/\" + \"discover\";",
      "const SUFFIX = \"discover\";",
      "const B = `server/${SUFFIX}`;",
      "const C = \"server/\" + SUFFIX;",
      "const D = \"server/list\";"
    ].join("\n");
    const hits = scanSource(sample).strings.filter(s => s.text.includes(DISCOVER)).map(s => s.line);
    assert.deepEqual([...new Set(hits)].sort((a, b) => a - b), [1, 3, 4]);
  });

  it("디스패처는 server/discover 요청에 결과 없이 -32601을 돌려준다", async () => {
    const { dispatchJsonRpc } = await import("../../lib/jsonrpc.js");
    const msg = {
      jsonrpc: "2.0",
      id     : "discover-1",
      method : DISCOVER,
      params : { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} } }
    };
    const { response } = await dispatchJsonRpc(msg, { authenticated: true, keyId: null, isMaster: true });
    assert.equal(response.result, undefined);
    assert.equal(response.error.code, -32601);
  });
});
