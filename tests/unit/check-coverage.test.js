/**
 * 커버리지 하한 점검 함수 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */

import { describe, it, before, after } from "node:test";
import assert                           from "node:assert/strict";
import fs                               from "node:fs";
import os                               from "node:os";
import path                             from "node:path";

import { parseLcov, summarize, findDrops, planWrite, runCli, CoverageInputError } from "../../scripts/check-coverage.js";

const LCOV = [
  "TN:", "SF:lib/a.js", "FNF:4", "FNH:2", "BRF:10", "BRH:5", "LF:100", "LH:80", "end_of_record",
  "TN:", "SF:lib/b.js", "FNF:0", "FNH:0", "BRF:0", "BRH:0", "LF:100", "LH:60", "end_of_record",
  "TN:", "SF:tests/x.test.js", "LF:10", "LH:10", "end_of_record", ""
].join("\n");

describe("check-coverage", () => {
  it("파일별 기록을 읽는다", () => {
    const recs = parseLcov(LCOV);
    assert.equal(recs.length, 3);
    assert.deepEqual(recs[0].lines, [80, 100]);
    assert.deepEqual(recs[0].functions, [2, 4]);
  });

  it("포함 조건에 맞는 파일만 합산한다", () => {
    const sum = summarize(parseLcov(LCOV), f => f.startsWith("lib/"));
    assert.deepEqual(sum, { lines: 70, branches: 50, functions: 50, files: 2 });
  });

  it("허용 폭 안의 하락은 통과하고 넘으면 지표 이름을 돌려준다", () => {
    const baseline = { lines: 76.43, branches: 74.68, functions: 63.13, tolerance: 0.5 };
    assert.deepEqual(findDrops({ lines: 76.0, branches: 74.3, functions: 62.7 }, baseline), []);
    const drops = findDrops({ lines: 75.9, branches: 74.68, functions: 63.13 }, baseline);
    assert.equal(drops.length, 1);
    assert.match(drops[0], /^lines: 75\.9% < 75\.93%/);
  });

  it("같은 입력은 항상 같은 합계를 낸다", () => {
    const recs = parseLcov(LCOV);
    assert.deepEqual(summarize(recs), summarize(parseLcov(LCOV)));
  });
});

describe("planWrite", () => {
  const prev = { lines: 76.43, branches: 74.68, functions: 63.13, tolerance: 0.5 };

  it("오른 값은 기록하고 허용 폭을 보존한다", () => {
    const plan = planWrite({ lines: 80, branches: 75, functions: 64, files: 3 }, prev, false);
    assert.deepEqual(plan, {
      ok  : true,
      next: { lines: 80, branches: 75, functions: 64, tolerance: 0.5 },
      lowered: []
    });
  });

  it("기준선보다 낮아지는 값은 허용 옵션 없이는 기록하지 않는다", () => {
    const plan = planWrite({ lines: 76.0, branches: 75, functions: 64, files: 3 }, prev, false);
    assert.equal(plan.ok, false);
    assert.equal(plan.lowered.length, 1);
    assert.match(plan.lowered[0], /^lines: 76% < 76\.43%/);
    assert.equal(planWrite({ lines: 76.0, branches: 75, functions: 64, files: 3 }, prev, true).ok, true);
  });

  it("기준선이 없으면 허용 폭 기본값 0.5로 처음 기록한다", () => {
    const plan = planWrite({ lines: 70, branches: 60, functions: 50, files: 3 }, null, false);
    assert.equal(plan.ok, true);
    assert.equal(plan.next.tolerance, 0.5);
  });
});

/** lcov 한 파일 기록을 만든다. 값은 문자열 그대로 넣어 잘못된 입력도 만들 수 있다. */
function lcovOf({ lf = "100", lh = "80", brf = "10", brh = "5", fnf = "4", fnh = "2" } = {}) {
  return ["TN:", "SF:lib/a.js", `FNF:${fnf}`, `FNH:${fnh}`, `BRF:${brf}`, `BRH:${brh}`, `LF:${lf}`, `LH:${lh}`, "end_of_record", ""].join("\n");
}

const GOOD_BASELINE = { lines: 70, branches: 40, functions: 40, tolerance: 0.5 };

describe("읽을 수 없는 입력은 통과시키지 않는다", () => {
  let dir;
  let seq = 0;

  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "check-coverage-")); });
  after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  /** lcov 본문과 기준선(객체, 원문 문자열, 또는 null=파일 없음)을 쓰고 runCli 의 종료 코드와 메시지를 돌려준다. */
  function exec(lcovText, baseline = GOOD_BASELINE, extraArgs = []) {
    const id       = seq++;
    const lcovPath = path.join(dir, `lcov-${id}.info`);
    const basePath = path.join(dir, `baseline-${id}.json`);
    fs.writeFileSync(lcovPath, lcovText);
    if (baseline !== null) fs.writeFileSync(basePath, typeof baseline === "string" ? baseline : JSON.stringify(baseline));
    const out = [];
    const err = [];
    const code = runCli([lcovPath, ...extraArgs], basePath, { log: m => out.push(m), error: m => err.push(m) });
    return { code, out, err, basePath };
  }

  it("정상 입력은 0으로 끝난다", () => {
    assert.equal(exec(lcovOf()).code, 0);
  });

  it("LF:abc 는 NaN 으로 통과하지 않고 2로 끝난다", () => {
    assert.throws(() => parseLcov(lcovOf({ lf: "abc" })), CoverageInputError);
    const r = exec(lcovOf({ lf: "abc" }));
    assert.equal(r.code, 2);
    assert.match(r.err.join("\n"), /LF:abc/);
    assert.equal(r.out.length, 0);
  });

  it("음수 값은 2로 끝난다", () => {
    assert.throws(() => parseLcov(lcovOf({ lh: "-5" })), CoverageInputError);
    assert.equal(exec(lcovOf({ lh: "-5" })).code, 2);
  });

  it("적중이 전체보다 크면 2로 끝난다", () => {
    assert.throws(() => parseLcov(lcovOf({ lf: "10", lh: "11" })), /적중 11/);
    assert.equal(exec(lcovOf({ lf: "10", lh: "11" })).code, 2);
    assert.equal(exec(lcovOf({ fnf: "1", fnh: "2" })).code, 2);
  });

  it("합계를 계산할 수 없는 lcov(유한한 지표 0개)는 2로 끝난다", () => {
    const allZero = lcovOf({ lf: "0", lh: "0", brf: "0", brh: "0", fnf: "0", fnh: "0" });
    assert.ok(Number.isNaN(summarize(parseLcov(allZero)).lines));
    assert.equal(exec(allZero).code, 2);
    assert.equal(exec("").code, 2);
  });

  it("기준선에 필드가 없으면 2로 끝난다", () => {
    for (const field of ["lines", "branches", "functions", "tolerance"]) {
      const baseline = { ...GOOD_BASELINE };
      delete baseline[field];
      assert.throws(() => findDrops({ lines: 80, branches: 50, functions: 50 }, baseline), CoverageInputError);
      assert.equal(exec(lcovOf(), baseline).code, 2, `${field} 누락`);
    }
  });

  it("기준선에 문자열 필드가 있으면 2로 끝난다", () => {
    const r = exec(lcovOf(), { ...GOOD_BASELINE, lines: "70" });
    assert.equal(r.code, 2);
    assert.match(r.err.join("\n"), /lines/);
    assert.equal(exec(lcovOf(), { ...GOOD_BASELINE, tolerance: "0.5" }).code, 2);
  });

  it("기준선이 JSON 이 아니거나 없으면 2로 끝난다", () => {
    assert.equal(exec(lcovOf(), "{ not json").code, 2);
    assert.equal(exec(lcovOf(), null).code, 2);
  });

  it("--write 도 읽을 수 없는 기준선이나 lcov 앞에서 파일을 쓰지 않고 2로 끝난다", () => {
    const badBase = exec(lcovOf(), { ...GOOD_BASELINE, branches: "x" }, ["--write"]);
    assert.equal(badBase.code, 2);
    assert.equal(JSON.parse(fs.readFileSync(badBase.basePath, "utf8")).branches, "x");

    const badLcov = exec(lcovOf({ lf: "abc" }), null, ["--write"]);
    assert.equal(badLcov.code, 2);
    assert.equal(fs.existsSync(badLcov.basePath), false);
  });

  it("객체가 아닌 값으로 해석되는 기준선은 --write 에서도 덮어쓰지 않고 2로 끝난다", () => {
    for (const raw of ["null", "0", "false", '""', "[]"]) {
      const res = exec(lcovOf(), raw, ["--write"]);
      assert.equal(res.code, 2, `기준선 ${raw}`);
      assert.equal(fs.readFileSync(res.basePath, "utf8"), raw, `기준선 ${raw} 는 그대로 남는다`);
      assert.equal(exec(lcovOf(), raw).code, 2, `점검 모드 기준선 ${raw}`);
    }
  });

  it("planWrite 는 기준선 자리의 null, 0, false, 빈 문자열을 없는 기준선으로 보지 않는다", () => {
    const current = { lines: 80, branches: 70, functions: 60, files: 3 };
    for (const prev of [0, false, ""]) {
      assert.throws(() => planWrite(current, prev, false), CoverageInputError, `prev ${JSON.stringify(prev)}`);
    }
    assert.equal(planWrite(current, null, false).ok, true);
    assert.equal(planWrite(current, undefined, false).ok, true);
  });

  it("음수 tolerance 는 2로 끝난다", () => {
    assert.throws(() => findDrops({ lines: 80, branches: 50, functions: 50 }, { ...GOOD_BASELINE, tolerance: -0.5 }), CoverageInputError);
    const r = exec(lcovOf(), { ...GOOD_BASELINE, tolerance: -0.5 });
    assert.equal(r.code, 2);
    assert.match(r.err.join("\n"), /tolerance/);
  });

  it("유한하지 않은 tolerance 는 2로 끝난다", () => {
    for (const tolerance of [NaN, Infinity, -Infinity]) {
      assert.throws(() => findDrops({ lines: 80, branches: 50, functions: 50 }, { ...GOOD_BASELINE, tolerance }), CoverageInputError, String(tolerance));
    }
    const r = exec(lcovOf(), '{"lines":70,"branches":40,"functions":40,"tolerance":1e999}');
    assert.equal(r.code, 2);
    assert.match(r.err.join("\n"), /tolerance/);
    assert.equal(exec(lcovOf(), { ...GOOD_BASELINE, tolerance: null }).code, 2);
  });

  it("BRH 가 BRF 보다 크면 2로 끝난다", () => {
    assert.throws(() => parseLcov(lcovOf({ brf: "5", brh: "6" })), /branches 적중 6/);
    const r = exec(lcovOf({ brf: "5", brh: "6" }));
    assert.equal(r.code, 2);
    assert.match(r.err.join("\n"), /branches 적중 6/);
    assert.equal(r.out.length, 0);
  });

  it("기준선 지표가 0 미만이거나 100 초과이면 2로 끝난다", () => {
    for (const metric of ["lines", "branches", "functions"]) {
      for (const value of [-0.01, 100.01]) {
        const baseline = { ...GOOD_BASELINE, [metric]: value };
        assert.throws(() => findDrops({ lines: 80, branches: 50, functions: 50 }, baseline), CoverageInputError, `${metric} ${value}`);
        const r = exec(lcovOf(), baseline);
        assert.equal(r.code, 2, `${metric} ${value}`);
        assert.match(r.err.join("\n"), new RegExp(metric));
      }
    }
  });

  it("저장소 소스가 없는 lcov(제외 대상 파일만)는 2로 끝난다", () => {
    const excluded = [
      "TN:", "SF:tests/x.test.js", "LF:10", "LH:10", "BRF:2", "BRH:2", "FNF:1", "FNH:1", "end_of_record",
      "TN:", "SF:node_modules/pkg/index.js", "LF:10", "LH:10", "BRF:2", "BRH:2", "FNF:1", "FNH:1", "end_of_record", ""
    ].join("\n");
    const r = exec(excluded);
    assert.equal(r.code, 2);
    assert.match(r.err.join("\n"), /소스 파일 기록이 없다/);
    assert.equal(r.out.length, 0);
    assert.equal(exec(excluded, null, ["--write"]).code, 2);
  });

  it("기준선 아래로 내려가면 1, 허용 폭 안이면 0으로 끝난다", () => {
    assert.equal(exec(lcovOf(), { ...GOOD_BASELINE, lines: 90 }).code, 1);
    assert.equal(exec(lcovOf(), { ...GOOD_BASELINE, lines: 80.3 }).code, 0);
  });
});
