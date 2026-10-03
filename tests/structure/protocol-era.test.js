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
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";
import { readFileSync } from "node:fs";
import path             from "node:path";
import { Linter }       from "eslint";

import { ROOT, listSourceFiles, scanFile } from "./_source-scan.js";

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

/**
 * 소스의 음수 수치 리터럴(-N)과 문자열 안의 -320NN 표기를 모은다.
 *
 * @param {string} source
 * @returns {Array<{ value: number, line: number }>}
 */
function negativeNumbers(source) {
  const found = [];
  const rule  = {
    create() {
      return {
        UnaryExpression(node) {
          if (node.operator === "-" && node.argument.type === "Literal" && typeof node.argument.value === "number") {
            found.push({ value: -node.argument.value, line: node.loc.start.line });
          }
        },
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
      "const e = -32601;"
    ].join("\n");
    const values = negativeNumbers(sample).map(n => n.value);
    assert.deepEqual(values.filter(isReservedCode).sort(), [-32022, -32021, -32020].sort());
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
