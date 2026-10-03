/**
 * 의미 쓰기 진입점 관문 구조 검사
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 의미 쓰기 진입점은 모두 WriteGate.check()를 거친다. 소스를 정적으로 읽어 세 가지를 본다.
 *
 *   1. 관문 함수: 표의 함수가 같은 파일 안에서 WriteGate의 check()를 호출하고, 그 파일이
 *      WriteGate.js를 import한다.
 *   2. 진입점: 열거한 진입점에서 위임 간선을 따라가면 관문 함수에 닿는다. 간선마다 호출식이
 *      출발 함수 안에 실제로 있어야 한다. 한 함수에서 나가는 간선은 모두 관문에 닿아야 한다.
 *   3. 의미 메서드 호출 위치: lib, scripts, bin에서 FragmentWriter 의미 메서드(insert, update)를
 *      부르는 곳은 관문 함수 안이거나, 같은 파일에서 관문 함수에서만 불리는 함수 안이거나, 사유가
 *      붙은 허용 목록에 있어야 한다. 수신 객체는 이름(store, writer)뿐 아니라 new FragmentWriter,
 *      new FragmentStore, a.store, a.writer를 담은 변수와 속성도 본다. 허용 목록 안의 호출도 기록
 *      값(객체 리터럴, 같은 함수의 초기화와 속성 대입)에 의미 열이 보이면 위반이다.
 *
 * 정적 검사가 놓치는 형태는 FragmentWriter의 실행 시 확인(관문 표식이 없는 의미 열 쓰기 거부)이 막는다.
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";

import { listSourceFiles, scanFile, scanSource } from "./_source-scan.js";
import { reachesGateCheck, semanticCallViolations, findSemanticCalls, gateApprovalImportViolations } from "./_write-rules.js";

const MR  = "lib/memory/processors/MemoryRememberer.js";
const MM  = "lib/memory/MemoryManager.js";
const BRP = "lib/memory/write/BatchRememberProcessor.js";
const RP  = "lib/memory/processors/ReflectProcessor.js";
const FI  = "lib/memory/write/FragmentImporter.js";
const IR  = "lib/memory/transfer/ImportRunner.js";
const TM  = "lib/tools/memory.js";
const CGC = "lib/memory/consolidate/ConsolidatorGC.js";

/** WriteGate.check()를 직접 부르는 함수 */
const GATED = Object.freeze([
  `${MR}::remember`,
  `${MR}::amend`,
  `${BRP}::_validateAndBuild`,
  `${RP}::_persistIndividually`,
  `${FI}::checkImportRow`,
  "lib/cli/remember.js::rememberLocal",
  `${CGC}::_processFragmentSplit`
]);

/** 위임 간선. 출발 함수 안에서 callee가 정규식과 맞는 호출이 있어야 한다. */
const EDGES = Object.freeze({
  [`${TM}::tool_remember`]                 : [[/^mgr\.remember$/, `${MM}::remember`]],
  [`${TM}::tool_amend`]                    : [[/^mgr\.amend$/, `${MM}::amend`]],
  [`${TM}::tool_batchRemember`]            : [[/^mgr\.batchRemember$/, `${MM}::batchRemember`]],
  [`${TM}::tool_reflect`]                  : [[/^mgr\.reflect$/, `${MM}::reflect`]],
  [`${MM}::remember`]                      : [[/^this\.rememberer\.remember$/, `${MR}::remember`]],
  [`${MM}::amend`]                         : [[/^this\.rememberer\.amend$/, `${MR}::amend`]],
  [`${MM}::batchRemember`]                 : [[/^this\.rememberer\.batchRemember$/, `${MR}::batchRemember`]],
  [`${MM}::reflect`]                       : [[/^this\.reflector\.reflect$/, "lib/memory/processors/MemoryReflector.js::reflect"]],
  [`${MR}::batchRemember`]                 : [[/^this\.batchRememberProcessor\.process$/, `${BRP}::process`]],
  [`${BRP}::process`]                      : [[/^this\._validateAndBuild$/, `${BRP}::_validateAndBuild`]],
  "lib/memory/write/BatchRememberWorker.js::_processJobEnvelope": [[/^this\.processor\.process$/, `${BRP}::process`]],
  "lib/memory/processors/MemoryReflector.js::reflect": [[/^this\.reflectProcessor\.process$/, `${RP}::process`]],
  [`${RP}::process`]: [
    [/^this\._persistFragmentItems$/, `${RP}::_persistFragmentItems`],
    [/^this\._buildEpisodes$/,        `${RP}::_buildEpisodes`]
  ],
  [`${RP}::_persistFragmentItems`]: [
    [/^this\._persistViaBatch$/,     `${RP}::_persistViaBatch`],
    [/^this\._persistIndividually$/, `${RP}::_persistIndividually`]
  ],
  [`${RP}::_persistViaBatch`]              : [[/^this\.batchRememberProcessor\.process$/, `${BRP}::process`]],
  /** ReflectProcessor의 remember는 MemoryManager가 생성자에서 묶어 넘긴 MemoryManager.remember다. */
  [`${RP}::_buildEpisodes`]                : [[/^this\.remember$/, `${MM}::remember`]],
  "lib/memory/processors/AutoReflect.js::_reflectWithGemini": [[/^mgr\.reflect$/, `${MM}::reflect`]],
  "lib/admin/admin-memory.js::handleFragmentPatch" : [[/^mgr\.amend$/, `${MM}::amend`]],
  "lib/admin/admin-memory.js::handleFragmentCreate": [[/^mgr\.remember$/, `${MM}::remember`]],
  "lib/admin/admin-export.js::handleImport": [[/^runImport$/, `${IR}::runImport`]],
  "lib/cli/import.js::importCmd"           : [[/^importRows$/, "lib/cli/import.js::importRows"]],
  "lib/cli/import.js::importRows"          : [[/^runImport$/, `${IR}::runImport`]],
  [`${IR}::runImport`]                     : [[/^dispatch$/, `${IR}::dispatch`]],
  [`${IR}::dispatch`]                      : [[/^importFragmentRecord$/, `${IR}::importFragmentRecord`]],
  [`${IR}::importFragmentRecord`]          : [[/^checkImportRow$/, `${FI}::checkImportRow`]],
  [`${CGC}::splitLongFragments`]           : [[/^this\._processFragmentSplit$/, `${CGC}::_processFragmentSplit`]],
  "lib/cli/remember.js::remember"          : [[/^rememberLocal$/, "lib/cli/remember.js::rememberLocal"]]
});

/** 열거한 의미 쓰기 진입점과 출발 함수 */
const ENTRY_POINTS = Object.freeze([
  ["MCP remember",                 `${TM}::tool_remember`],
  ["MCP amend",                    `${TM}::tool_amend`],
  ["MCP batch_remember",           `${TM}::tool_batchRemember`],
  ["batch_remember 비동기 작업자", "lib/memory/write/BatchRememberWorker.js::_processJobEnvelope"],
  ["reflect 파생 파편",            `${TM}::tool_reflect`],
  ["AutoReflect",                  "lib/memory/processors/AutoReflect.js::_reflectWithGemini"],
  ["admin import",                 "lib/admin/admin-export.js::handleImport"],
  ["CLI import",                   "lib/cli/import.js::importCmd"],
  ["CLI remember 로컬 모드",       "lib/cli/remember.js::remember"],
  ["admin 기억 PATCH",             "lib/admin/admin-memory.js::handleFragmentPatch"],
  ["admin 기억 POST",              "lib/admin/admin-memory.js::handleFragmentCreate"],
  ["통합 분할 자식",               `${CGC}::splitLongFragments`]
]);

/** 관문 밖에서 의미 메서드 이름을 부를 수 있는 위치. 키는 "파일::함수", 값은 사유다. */
const ALLOWED_SEMANTIC_CALLS = Object.freeze({
  "lib/memory/write/FragmentStore.js::insert":
    "FragmentStore 파사드가 FragmentWriter.insert로 위임한다. 파사드의 호출자를 검사한다",
  "lib/memory/write/FragmentStore.js::update":
    "FragmentStore 파사드가 FragmentWriter.update로 위임한다. 파사드의 호출자를 검사한다",
  [`${FI}::writeImportRow`]:
    "checkImportRow가 만든 관문 통과 후보만 받는다. ImportRunner가 checkImportRow 결과로만 부르고 FragmentWriter가 관문 표식을 실행 시 확인한다",
  [`${MR}::normalizeFragmentAgentToDefault`]:
    "승인 목록 CLI의 agent_id 공유 전환이다. 의미 열을 넘기지 않고 이력 보관 트랜잭션이 필요해 update를 쓴다",
  "lib/memory/processors/MemoryLinker.js::link":
    "resolved_by 링크 대상 error 파편의 importance만 낮춘다. 의미 열을 넘기지 않는다",
  "lib/memory/signals/MemoryEvaluator.js::_dropOverflow":
    "평가 대기열에서 밀려난 파편의 quality_verified만 기록한다",
  "lib/memory/signals/MemoryEvaluator.js::evaluate":
    "평가 결과의 importance와 품질 열만 기록하고 검증 시각을 갱신한다",
  "lib/memory/write/RememberPostProcessor.js::_extractSymbolicClaims":
    "ClaimStore.insert다. fragment_claims 표에 쓰고 파편 의미 열은 쓰지 않는다",
  "scripts/backfill-claims.js::processFragment":
    "ClaimStore.insert다. fragment_claims 표에 쓰고 파편 의미 열은 쓰지 않는다"
});

const scanCache = new Map();
const MISSING   = Object.freeze({ calls: [], strings: [], imports: [], missing: true });
function scan(file) {
  if (!scanCache.has(file)) {
    try {
      scanCache.set(file, scanFile(file));
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      scanCache.set(file, MISSING);
    }
  }
  return scanCache.get(file);
}

function split(key) {
  const [file, fn] = key.split("::");
  return { file, fn };
}

/** 함수 안(중첩 함수 포함)의 호출식 */
function callsIn(file, fn) {
  return scan(file).calls.filter(c => c.scope.includes(fn));
}

/** 진입점에서 간선을 따라 관문 함수에 닿는지 본다. 실패 사유를 모아 돌려준다. */
function traceToGate(key, path = []) {
  if (GATED.includes(key)) {
    const { file, fn } = split(key);
    return reachesGateCheck(scan(file), fn) ? [] : [`${key}: WriteGate.check() 호출 없음`];
  }
  if (path.includes(key)) return [`순환: ${[...path, key].join(" -> ")}`];
  const edges = EDGES[key];
  if (!edges) return [`관문에 닿지 않는 함수: ${key}`];

  const { file, fn } = split(key);
  const problems     = [];
  for (const [pattern, target] of edges) {
    if (!callsIn(file, fn).some(c => pattern.test(c.callee))) {
      problems.push(`${key}에 ${pattern} 호출이 없다`);
      continue;
    }
    problems.push(...traceToGate(target, [...path, key]));
  }
  return problems;
}

/** 파일의 관문 함수 이름 */
function gatedFnsOf(file) {
  return GATED.map(split).filter(g => g.file === file).map(g => g.fn);
}

describe("의미 쓰기 진입점 관문", () => {
  it("관문 함수는 WriteGate.check()를 부르고 그 파일은 WriteGate.js를 import한다", () => {
    const problems = [];
    for (const key of GATED) {
      const { file, fn } = split(key);
      if (scan(file).missing) {
        problems.push(`${file}: 파일 없음`);
        continue;
      }
      if (!scan(file).imports.some(spec => /(^|\/)WriteGate\.js$/.test(spec))) problems.push(`${file}: WriteGate.js import 없음`);
      if (!reachesGateCheck(scan(file), fn)) problems.push(`${key}: WriteGate.check() 호출 없음`);
    }
    assert.deepEqual(problems, [], problems.join("\n"));
  });

  for (const [name, start] of ENTRY_POINTS) {
    it(`${name} 진입점은 관문에 닿는다`, () => {
      const problems = traceToGate(start);
      assert.deepEqual(problems, [], problems.join("\n"));
    });
  }

  it("의미 메서드 호출은 관문 안이나 사유가 붙은 허용 목록에만 있다", () => {
    const files     = [...listSourceFiles("lib"), ...listSourceFiles("scripts"), ...listSourceFiles("bin")];
    const offenders = files.flatMap(file =>
      semanticCallViolations(file, scan(file), { gatedFns: gatedFnsOf(file), allowed: ALLOWED_SEMANTIC_CALLS })
    );
    assert.deepEqual(offenders, [], `관문 밖 의미 메서드 호출:\n${offenders.join("\n")}`);
  });

  it("관문 통과 표식 등록 함수는 WriteGate만 가져온다", () => {
    const files      = [...listSourceFiles("lib"), ...listSourceFiles("scripts"), ...listSourceFiles("bin")];
    const violations = files.flatMap(file => gateApprovalImportViolations(file, scan(file)));
    assert.deepEqual(violations, []);
    const writeGate = scan("lib/memory/write/WriteGate.js").importSpecs;
    assert.ok(writeGate.some(sp => /gateApproval\.js$/.test(sp.source) && sp.imported === "approveGateValue"), "WriteGate가 등록 함수를 가져오지 않는다");
  });

  it("허용 항목마다 사유가 있고 더는 쓰지 않는 항목이 남아 있지 않다", () => {
    for (const [key, reason] of Object.entries(ALLOWED_SEMANTIC_CALLS)) {
      assert.ok(typeof reason === "string" && reason.trim().length >= 10, `${key}: 사유가 비었거나 너무 짧다`);
      const { file, fn } = split(key);
      const used = findSemanticCalls(file, scan(file)).some(site => site.scope.includes(fn));
      assert.ok(used, `정리된 항목은 목록에서 지운다: ${key}`);
    }
  });
});

describe("의미 메서드 호출 탐지 규칙", () => {
  const violations = (source, { gatedFns = [], allowed = {} } = {}) =>
    semanticCallViolations("synthetic.js", scanSource(source), { gatedFns, allowed });

  it("이름이 다른 수신 객체도 FragmentStore 바인딩이면 찾는다", () => {
    const found = violations([
      "const fragmentStore = new FragmentStore();",
      "export async function patch(id) { await fragmentStore.update(id, { content: \"x\" }); }"
    ].join("\n"));
    assert.equal(found.length, 1);
    assert.match(found[0], /fragmentStore\.update, 의미 열 content/);
  });

  it("a.store를 담은 변수로 부르는 insert도 찾는다", () => {
    const found = violations("export async function put(mgr, f) { const target = mgr.store; await target.insert(f); }");
    assert.equal(found.length, 1);
  });

  it("허용 목록 함수라도 기록 값에 의미 열을 넣으면 위반이다", () => {
    const source = [
      "export async function evaluate(mgr, id) {",
      "  const updates = { importance: 0.4 };",
      "  updates.content = \"rewritten\";",
      "  await mgr.store.update(id, updates, \"system\");",
      "}"
    ].join("\n");
    const found = violations(source, { allowed: { "synthetic.js::evaluate": "시험용 허용 항목이다, 의미 열 없이 쓴다" } });
    assert.equal(found.length, 1);
    assert.match(found[0], /의미 열 content/);
  });

  it("허용 목록 함수가 의미 열 없이 쓰면 통과하고 관문 함수 안의 호출도 통과한다", () => {
    const allowed = { "synthetic.js::evaluate": "시험용 허용 항목이다, 의미 열 없이 쓴다" };
    assert.deepEqual(violations("export async function evaluate(mgr, id) { await mgr.store.update(id, { importance: 0.4 }); }", { allowed }), []);
    assert.deepEqual(violations([
      "export async function save(gate, store, input) {",
      "  const { draft } = await gate.check(input);",
      "  await store.insert(draft);",
      "}"
    ].join("\n"), { gatedFns: ["save"] }), []);
  });
});

describe("관문 통과 표식 가져오기 탐지 규칙", () => {
  const violations = (source, file = "lib/synthetic.js") => gateApprovalImportViolations(file, scanSource(source));

  it("별칭으로 가져온 등록 함수를 찾는다", () => {
    const found = violations('import { approveGateValue as ok } from "./memory/write/gateApproval.js";\nexport const forge = (x) => ok(x);');
    assert.equal(found.length, 1);
  });

  it("이름공간 가져오기와 동적 가져오기를 찾는다", () => {
    assert.equal(violations('import * as g from "./write/gateApproval.js";\nexport const forge = (x) => g.approveGateValue(x);').length, 1);
    assert.equal(violations('export async function forge(x) { const g = await import("./write/gateApproval.js"); return g.approveGateValue(x); }').length, 1);
    assert.equal(violations('export { approveGateValue } from "./write/gateApproval.js";').length, 1);
  });

  it("확인 함수만 가져오는 것과 WriteGate.js의 등록 함수 가져오기는 통과한다", () => {
    assert.deepEqual(violations('import { isGateApproved } from "./gateApproval.js";\nexport const ok = (x) => isGateApproved(x);'), []);
    assert.deepEqual(violations('import { approveGateValue } from "./gateApproval.js";', "lib/memory/write/WriteGate.js"), []);
  });
});
