/**
 * 지표 라벨 값의 출처 구조 검사
 *
 * 지표 기록 함수에 넘기는 라벨 인자는 리터럴이거나, 값을 닫힌 집합으로 바꾸는
 * 기록 함수에 넘기거나, 아래 REVIEWED 목록에 근거와 함께 올라 있어야 한다.
 * 목록에 없는 새 식이 라벨 자리에 오면 실패한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */
import { describe, it } from "node:test";
import assert           from "node:assert/strict";
import fs               from "node:fs";
import path             from "node:path";
import { Linter }       from "eslint";

const ROOT = path.resolve(import.meta.dirname, "../..");

/** 기록 함수별 라벨 인자 위치 */
const LABEL_PARAMS = new Map([
  ["recordHttpRequest",             [0, 1, 2]],
  ["recordRpcMethod",               [0, 1]],
  ["recordToolExecution",           [0, 1]],
  ["recordError",                   [0, 1]],
  ["recordAuthenticationAttempt",   [0, 1]],
  ["recordAuthDenied",              [0]],
  ["recordCorsDenied",              [0]],
  ["recordRbacDenied",              [0, 1]],
  ["recordTenantIsolationBlocked",  [0]],
  ["recordRedisSessionSaveFailure", [0]],
  ["recordSessionRecovery",         [0]],
  ["recordOAuthTokenIssued",        [0]],
  ["recordOriginRejected",          [0]],
  ["recordProtocolVersionRejected", [0]],
  ["recordGateBlock",               [0, 1]],
  ["recordGateAllow",               [0]],
  ["recordSplitSkip",               [0]],
  ["recordWarning",                 [0, 1]],
  ["recordClaim",                   [0, 1]]
]);

/** 기록 함수 안에서 protocolVersionLabel로 값을 닫는 함수 */
const BOUNDED_RECORDERS = new Set(["recordProtocolNegotiation", "recordProtocolVersionReanchored"]);

/** 지표 정의 모듈. 이 안의 .inc()/.observe()는 매개변수를 그대로 쓰므로 호출부에서 본다. */
const METRIC_MODULES = new Set([
  "lib/metrics.js",
  "lib/llm/metrics.js",
  "lib/symbolic/SymbolicMetrics.js",
  "lib/memory/consolidate/gate-metrics.js",
  "lib/memory/consolidate/split-metrics.js"
]);

/** 검토를 마친 비리터럴 라벨 식. 키는 "파일|함수|식", 값은 값이 닫힌 집합인 근거다. */
const REVIEWED = new Map([
  ["server.js|recordHttpRequest|req.method",                                      "Node HTTP 파서가 http.METHODS(35개) 밖 메서드를 400으로 끊는다"],
  ["lib/handlers/health-handler.js|recordHttpRequest|req.method",                 "Node HTTP 파서가 http.METHODS(35개) 밖 메서드를 400으로 끊는다"],
  ["lib/handlers/health-handler.js|recordHttpRequest|statusCode",                 "200 또는 503"],
  ["lib/handlers/mcp-handler.js|recordHttpRequest|req.method",                    "Node HTTP 파서가 http.METHODS(35개) 밖 메서드를 400으로 끊는다"],
  ["lib/jsonrpc.js|recordRbacDenied|name",                                        "TOOL_REGISTRY.get(name) 통과 후에만 도달한다"],
  ["lib/jsonrpc.js|recordRbacDenied|`requires_${required}`",                      "checkPermission이 돌려주는 권한 이름"],
  ["lib/jsonrpc.js|recordToolExecution|name",                                     "TOOL_REGISTRY.get(name) 통과 후에만 도달한다"],
  ["lib/jsonrpc.js|recordError|method",                                           "METHOD_MAP 키의 처리기가 던진 경우에만 도달한다"],
  ["lib/jsonrpc.js|recordError|errorCode",                                        "서버 코드가 붙인 오류 코드"],
  ["lib/llm/index.js|inc|provider.name",                                          "등록된 provider 이름"],
  ["lib/llm/index.js|observe|provider.name",                                      "등록된 provider 이름"],
  ["lib/llm/index.js|dec|provider.name",                                          "등록된 provider 이름"],
  ["lib/llm/index.js|inc|primaryName",                                            "등록된 provider 이름"],
  ["lib/llm/providers/OpenAICompatibleProvider.js|inc|this.name",                 "등록된 provider 이름"],
  ["lib/memory/consolidate/ConsolidatorGC.js|recordSplitSkip|reason",             "splitLongFragments 안의 고정 사유 문자열"],
  ["lib/memory/consolidate/MemoryConsolidator.js|recordGateBlock|verdict.reason", "consolidate-gate 판정 사유 상수"],
  ["lib/memory/processors/MemoryRememberer.js|recordWarning|`policy.${v.rule}`",  "PolicyRules 규칙 이름"],
  ["lib/memory/processors/MemoryRememberer.js|recordWarning|v.severity || \"low\"", "PolicyRules 심각도 상수"],
  ["lib/memory/processors/MemoryRememberer.js|recordGateBlock|gateEligible[0]?.rule ?? \"unknown\"", "PolicyRules 규칙 이름"],
  ["lib/memory/write/RememberPostProcessor.js|recordClaim|c.extractor ?? \"morpheme-rule\"", "ClaimExtractor 추출기 이름"],
  ["lib/memory/write/RememberPostProcessor.js|recordClaim|c.polarity ?? \"uncertain\"",       "ClaimExtractor 극성 상수"],
  ["lib/memory/write/RememberPostProcessor.js|recordGateBlock|gateResult.reason",            "proactive-gate 판정 사유 상수"],
  ["lib/symbolic/CbrEligibility.js|recordGateBlock|reason",                       "CbrEligibility 판정 사유 상수"],
  ["lib/symbolic/ClaimConflictDetector.js|recordWarning|RULE_ID",                 "모듈 상수"],
  ["lib/symbolic/ClaimConflictDetector.js|recordWarning|severity",                "판정 심각도 상수"]
]);

/** 리터럴, 식 없는 템플릿, 리터럴의 단항식, 두 갈래가 모두 리터럴인 조건식이면 정적으로 닫혀 있다. */
function isStaticLabel(node) {
  if (node.type === "Literal")               return true;
  if (node.type === "TemplateLiteral")       return node.expressions.length === 0;
  if (node.type === "UnaryExpression")       return node.argument.type === "Literal";
  if (node.type === "ConditionalExpression") return isStaticLabel(node.consequent) && isStaticLabel(node.alternate);
  return false;
}

function listJs(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJs(full));
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

/** 운영 코드에서 검토 대상 라벨 식을 모은다. */
function collectLabelExpressions() {
  const found = [];
  const files = [...listJs(path.join(ROOT, "lib")), path.join(ROOT, "server.js")];
  for (const file of files) {
    const rel    = path.relative(ROOT, file).split(path.sep).join("/");
    const linter = new Linter();
    const rule   = {
      create(context) {
        const text = (n) => context.sourceCode.getText(n);
        return {
          CallExpression(node) {
            const callee = node.callee;
            const name   = callee.type === "Identifier" ? callee.name
              : (callee.type === "MemberExpression" && !callee.computed ? callee.property.name : null);
            if (name === null || BOUNDED_RECORDERS.has(name) || METRIC_MODULES.has(rel)) return;
            if (LABEL_PARAMS.has(name)) {
              for (const i of LABEL_PARAMS.get(name)) {
                const arg = node.arguments[i];
                if (arg && !isStaticLabel(arg)) found.push(`${rel}|${name}|${text(arg)}`);
              }
            }
            if (["inc", "dec", "observe"].includes(name) && node.arguments[0]?.type === "ObjectExpression") {
              for (const prop of node.arguments[0].properties) {
                if (prop.type === "Property" && !isStaticLabel(prop.value)) found.push(`${rel}|${name}|${text(prop.value)}`);
              }
            }
          }
        };
      }
    };
    const messages = linter.verify(fs.readFileSync(file, "utf8"), [{
      plugins        : { probe: { rules: { labels: rule } } },
      rules          : { "probe/labels": "error" },
      languageOptions: { ecmaVersion: "latest", sourceType: "module" }
    }]);
    const fatal = messages.find(m => m.fatal);
    if (fatal) throw new Error(`${rel}: ${fatal.message}`);
  }
  return found;
}

describe("지표 라벨 값의 출처", () => {
  const found = collectLabelExpressions();

  it("검토되지 않은 비리터럴 라벨 식이 없다", () => {
    const unreviewed = [...new Set(found)].filter(key => !REVIEWED.has(key));
    assert.deepEqual(unreviewed, [], `검토 목록에 없는 라벨 식:\n${unreviewed.join("\n")}`);
  });

  it("검토 목록에 더 이상 쓰이지 않는 항목이 없다", () => {
    const used  = new Set(found);
    const stale = [...REVIEWED.keys()].filter(key => !used.has(key));
    assert.deepEqual(stale, [], `코드에서 사라진 검토 항목:\n${stale.join("\n")}`);
  });

  it("값을 닫는 기록 함수는 protocolVersionLabel을 거친다", () => {
    const src = fs.readFileSync(path.join(ROOT, "lib/metrics.js"), "utf8");
    for (const name of BOUNDED_RECORDERS) {
      const start = src.indexOf(`export function ${name}(`);
      assert.ok(start >= 0, `${name} 정의가 없다`);
      const body  = src.slice(start, src.indexOf("\n}\n", start));
      assert.match(body, /protocolVersionLabel\(/, `${name}가 라벨 값을 닫지 않는다`);
    }
  });
});
