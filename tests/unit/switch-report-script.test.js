/**
 * 스위치 보고 스크립트 시험
 *
 * scripts/switch-report.mjs가 프로세스 환경만 읽고, .env 파일을 읽지 않으며,
 * 키와 잘못된 원본 값을 출력하지 않는지 자식 프로세스로 검사한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */

import { describe, it, before, after } from "node:test";
import assert                          from "node:assert/strict";
import { spawnSync }                   from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir }                      from "node:os";
import path                            from "node:path";
import { fileURLToPath }               from "node:url";

import { SWITCHES } from "../../config/switches.js";
import { uncommentedAssignments } from "./switch-source-helpers.js";

const SCRIPT = fileURLToPath(new URL("../../scripts/switch-report.mjs", import.meta.url));

/** 부모 환경을 넘기지 않고 지정한 변수만 가진 자식 환경으로 실행한다. */
function run(env, { cwd, args = [] } = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    env     : { PATH: process.env.PATH, ...env },
    encoding: "utf8"
  });
}

describe("switch-report.mjs", () => {
  let dir;
  before(() => { dir = mkdtempSync(path.join(tmpdir(), "switch-report-")); });
  after(() => { rmSync(dir, { recursive: true, force: true }); });

  it("스위치마다 한 줄인 표를 출력하고 0으로 끝난다", () => {
    const res = run({}, { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    const rows = res.stdout.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| 스위치 |"));
    assert.equal(rows.length, SWITCHES.length);
    assert.ok(res.stdout.includes("| 스위치 | 적용 값 | 기본값 | 상태 |"));
  });

  it("프로세스 환경의 값을 반영한다", () => {
    const res = run({ MEMENTO_WORKSPACE_GATE: "true" }, { cwd: dir });
    const row = res.stdout.split("\n").find((l) => l.startsWith("| MEMENTO_WORKSPACE_GATE |"));
    assert.ok(row.includes("| true | false | on | 예 |"), row);
  });

  it("현재 디렉터리의 .env 파일을 읽지 않는다", () => {
    writeFileSync(path.join(dir, ".env"), "MEMENTO_WORKSPACE_GATE=true\nMEMENTO_API_KEY_DELETE_GUARD=false\n");
    const res = run({}, { cwd: dir });
    const gate = res.stdout.split("\n").find((l) => l.startsWith("| MEMENTO_WORKSPACE_GATE |"));
    assert.ok(gate.includes("| false | false | off | 아니오 |"), gate);
    const guard = res.stdout.split("\n").find((l) => l.startsWith("| MEMENTO_API_KEY_DELETE_GUARD |"));
    assert.ok(guard.includes("| true | true | on | 아니오 |"), guard);
  });

  it("키와 잘못된 원본 값을 출력하지 않는다", () => {
    const res = run({
      MEMENTO_ACCESS_KEY    : "access_SECRET_123",
      OPENAI_API_KEY        : "sk_SECRET_456",
      POSTGRES_PASSWORD     : "pw_SECRET_789",
      MEMENTO_WORKSPACE_GATE: "bad_SECRET_000"
    }, { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.ok(!/_SECRET_/.test(res.stdout + res.stderr));
    assert.ok(res.stdout.includes("값 오류"));
  });

  it("--strict이면 잘못된 값이 있을 때만 표를 출력한 뒤 1로 끝난다", () => {
    const bad = run({ MEMENTO_CORS_MODE: "bogus_SECRET_1" }, { cwd: dir, args: ["--strict"] });
    assert.equal(bad.status, 1);
    assert.ok(bad.stdout.includes("| 스위치 |"));
    assert.ok(bad.stderr.includes("MEMENTO_CORS_MODE"));
    assert.ok(!/_SECRET_/.test(bad.stdout + bad.stderr));
    assert.equal(run({}, { cwd: dir, args: ["--strict"] }).status, 0);
    assert.equal(run({ MEMENTO_WORKSPACE_GATE: "true" }, { cwd: dir, args: ["--strict"] }).status, 0);
  });

  it("옵션이 없으면 잘못된 값이 있어도 0으로 끝난다", () => {
    assert.equal(run({ MEMENTO_CORS_MODE: "bogus" }, { cwd: dir }).status, 0);
  });

  for (const file of [".env.example", ".env.example.minimal"]) {
    it(`${file}의 주석 처리 없는 스위치 값으로 만든 환경에서 --strict가 0으로 끝난다`, () => {
      const names = new Set(SWITCHES.map((x) => x.name));
      const text  = readFileSync(fileURLToPath(new URL(`../../${file}`, import.meta.url)), "utf8");
      const env   = Object.fromEntries(Object.entries(uncommentedAssignments(text)).filter(([n]) => names.has(n)));
      const res   = run(env, { cwd: dir, args: ["--strict"] });
      assert.equal(res.status, 0, res.stderr);
    });
  }
});
