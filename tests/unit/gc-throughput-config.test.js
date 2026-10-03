/**
 * 만료 GC 처리량 환경 변수 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * MEMENTO_GC_MAX_DELETE_PER_CYCLE, MEMENTO_GC_TIME_BUDGET_MS, MEMENTO_GC_THROUGHPUT의 기본값,
 * 허용 범위, 기동 시 설정 문제 목록 기록을 확인한다.
 */

import { describe, it }  from "node:test";
import assert            from "node:assert/strict";
import { execFileSync }  from "node:child_process";

const load = (env) => JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `
  const c = await import("./lib/config.js");
  console.log(JSON.stringify({
    cap: c.gcMaxDeletePerCycle(), budget: c.gcTimeBudgetMs(), on: c.gcThroughputEnabled(),
    issues: c.getConfigIssues().map(i => [i.name, i.problem, i.used])
  }));
`], {
  cwd     : new URL("../../", import.meta.url),
  env     : { PATH: process.env.PATH, DOTENV_CONFIG_PATH: "/nonexistent.env", ...env },
  encoding: "utf8"
}));

describe("만료 GC 처리량 설정", () => {
  it("미설정이면 4000건, 60초, 켜짐이고 문제가 없다", () => {
    const r = load({});
    assert.deepEqual({ cap: r.cap, budget: r.budget, on: r.on }, { cap: 4000, budget: 60000, on: true });
    assert.deepEqual(r.issues, []);
  });

  it("기본 상한은 30일 일평균 유입(약 1884건)의 두 배 이상이고 500 이상이다", () => {
    const { cap } = load({});
    assert.ok(cap >= 2 * 1884 && cap >= 500);
  });

  it("허용 범위의 값을 그대로 쓴다", () => {
    const r = load({ MEMENTO_GC_MAX_DELETE_PER_CYCLE: "100", MEMENTO_GC_TIME_BUDGET_MS: "600000", MEMENTO_GC_THROUGHPUT: "off" });
    assert.deepEqual({ cap: r.cap, budget: r.budget, on: r.on }, { cap: 100, budget: 600000, on: false });
    assert.deepEqual(r.issues, []);
  });

  it("범위 밖이거나 숫자가 아닌 값은 기본값을 쓰고 기동 시 설정 문제 목록에 오른다", () => {
    const r = load({ MEMENTO_GC_MAX_DELETE_PER_CYCLE: "99", MEMENTO_GC_TIME_BUDGET_MS: "soon", MEMENTO_GC_THROUGHPUT: "maybe" });
    assert.deepEqual({ cap: r.cap, budget: r.budget, on: r.on }, { cap: 4000, budget: 60000, on: true });
    const names = r.issues.map(i => i[0]).sort();
    assert.deepEqual(names, ["MEMENTO_GC_MAX_DELETE_PER_CYCLE", "MEMENTO_GC_THROUGHPUT", "MEMENTO_GC_TIME_BUDGET_MS"]);
  });

  it("상한과 예산의 위쪽 경계를 넘는 값은 기본값을 쓴다", () => {
    const r = load({ MEMENTO_GC_MAX_DELETE_PER_CYCLE: "100001", MEMENTO_GC_TIME_BUDGET_MS: "600001" });
    assert.deepEqual({ cap: r.cap, budget: r.budget }, { cap: 4000, budget: 60000 });
  });
});
