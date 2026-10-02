/**
 * 환경 변수 파싱 도우미 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */
import { describe, it, afterEach } from "node:test";
import assert                      from "node:assert/strict";
import { readFileSync }            from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync }     from "node:fs";
import { tmpdir }                  from "node:os";
import path                        from "node:path";

import { envInt, envFloat, envBool, envEnum, getConfigIssues } from "../../lib/config.js";

const NAME = "P3_TEST_ENV_VALUE";

afterEach(() => { delete process.env[NAME]; });

const issuesFor = (problem) => getConfigIssues().filter(i => i.name === NAME && i.problem === problem);

describe("envInt", () => {
  it("미설정과 공백은 기본값이다", () => {
    assert.equal(envInt(NAME, 7), 7);
    process.env[NAME] = "  ";
    assert.equal(envInt(NAME, 7), 7);
  });

  it("숫자는 Number 규칙으로 읽는다", () => {
    process.env[NAME] = "0";
    assert.equal(envInt(NAME, 7), 0);
    process.env[NAME] = " 42 ";
    assert.equal(envInt(NAME, 7), 42);
  });

  it("숫자가 아니면 기본값을 쓰고 not_a_number로 한 번만 기록한다", () => {
    process.env[NAME] = "abc";
    assert.equal(envInt(NAME, 7), 7);
    assert.equal(envInt(NAME, 7), 7);
    assert.equal(issuesFor("not_a_number").length, 1);
  });

  it("범위 밖과 정수 아님은 값을 쓰고 기록한다", () => {
    process.env[NAME] = "-3";
    assert.equal(envInt(NAME, 7, { min: 0 }), -3);
    assert.equal(issuesFor("below_min").length, 1);
    process.env[NAME] = "2.5";
    assert.equal(envInt(NAME, 7), 2.5);
    assert.equal(issuesFor("not_integer").length, 1);
  });

  it("fallback 옵션이면 범위 밖 값 대신 기본값을 쓰고 기록한다", () => {
    const FB = "P3_TEST_ENV_FALLBACK";
    const of = (problem) => getConfigIssues().filter(i => i.name === FB && i.problem === problem);
    try {
      process.env[FB] = "-3";
      assert.equal(envInt(FB, 7, { min: 0, fallback: true }), 7);
      assert.equal(of("below_min")[0].used, 7);
      process.env[FB] = "9000";
      assert.equal(envInt(FB, 7, { min: 0, max: 100, fallback: true }), 7);
      assert.equal(of("above_max").length, 1);
      process.env[FB] = "2.5";
      assert.equal(envInt(FB, 7, { fallback: true }), 7);
      assert.equal(of("not_integer").length, 1);
      process.env[FB] = "50";
      assert.equal(envInt(FB, 7, { min: 0, max: 100, fallback: true }), 50);
    } finally {
      delete process.env[FB];
    }
  });

  it("기본값 null을 그대로 돌려준다", () => {
    assert.equal(envInt(NAME, null), null);
  });
});

describe("envFloat, envBool, envEnum", () => {
  it("envFloat은 소수를 허용한다", () => {
    process.env[NAME] = "0.5";
    assert.equal(envFloat(NAME, 1), 0.5);
  });

  it("envBool은 true와 false만 값으로 본다", () => {
    process.env[NAME] = "true";
    assert.equal(envBool(NAME, false), true);
    process.env[NAME] = "yes";
    assert.equal(envBool(NAME, false), false);
    assert.equal(issuesFor("not_boolean").length, 1);
  });

  it("envEnum은 목록 밖이면 기본값이다", () => {
    process.env[NAME] = "503";
    assert.equal(envEnum(NAME, ["401", "503"], "401"), "503");
    process.env[NAME] = "418";
    assert.equal(envEnum(NAME, ["401", "503"], "401"), "401");
    assert.equal(issuesFor("not_in_enum").length, 1);
  });
});

describe("설정 모듈 밖 읽기", () => {
  const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

  it("서버 타임아웃과 질의 타임아웃은 도우미로 읽는다", () => {
    const server = read("server.js");
    assert.match(server, /envInt\("KEEP_ALIVE_TIMEOUT_MS"/);
    assert.match(server, /envInt\("HEADERS_TIMEOUT_MS"/);
    assert.match(read("lib/tools/db.js"), /envInt\("DB_STATEMENT_TIMEOUT_MS"/);
  });

  it("무가드 숫자 파싱이 설정 모듈에 남지 않는다", () => {
    const unguarded = read("lib/config.js").split("\n")
      .filter(line => /(?<![.\w])(Number|parseInt)\(\s*process\.env/.test(line));
    assert.deepEqual(unguarded, []);
  });

  it("서킷브레이커는 설정 모듈의 값을 쓴다", () => {
    assert.doesNotMatch(read("lib/llm/util/circuit-breaker.js"), /process\.env/);
  });
});

describe("모듈 적재 시점의 값 검사", () => {
  const load = (env) => JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `
    const c = await import("./lib/config.js");
    console.log(JSON.stringify({
      port: c.PORT, dbPort: c.DB_PORT, ttl: c.SESSION_TTL_MS, ready: c.HEALTH_READY_DB_TIMEOUT_MS, deadline: c.SHUTDOWN_DEADLINE_MS,
      strict: c.CONFIG_STRICT, issues: c.getConfigIssues().map(i => [i.name, i.problem, i.used])
    }));
  `], {
    cwd: new URL("../../", import.meta.url),
    env: { PATH: process.env.PATH, DOTENV_CONFIG_PATH: "/nonexistent.env", ...env },
    encoding: "utf8"
  }));

  it("설정이 없으면 기본값이고 문제가 없다", () => {
    const r = load({});
    assert.deepEqual(r.issues, []);
    assert.equal(r.port, 57332);
    assert.equal(r.ready, 2000);
    assert.equal(r.deadline, 60000);
    assert.equal(r.strict, false);
  });

  it("숫자가 아닌 값은 기본값으로 돌아가고 한 번씩 기록된다", () => {
    const r = load({
      PORT: "abc", SESSION_TTL_MINUTES: "x1",
      MEMENTO_HEALTH_READY_DB_TIMEOUT_MS: "soon", MEMENTO_SHUTDOWN_DEADLINE_MS: "later"
    });
    assert.equal(r.port, 57332);
    assert.equal(r.ttl, 43200 * 60 * 1000);
    assert.equal(r.ready, 2000);
    assert.equal(r.deadline, 60000);
    assert.deepEqual(r.issues.map(i => i[0]).sort(), [
      "MEMENTO_HEALTH_READY_DB_TIMEOUT_MS", "MEMENTO_SHUTDOWN_DEADLINE_MS", "PORT", "SESSION_TTL_MINUTES"
    ]);
  });

  it("준비 상태 상한과 종료 상한은 범위 밖이면 기본값이다", () => {
    const r = load({ MEMENTO_HEALTH_READY_DB_TIMEOUT_MS: "9000", MEMENTO_SHUTDOWN_DEADLINE_MS: "-1" });
    assert.equal(r.ready, 2000);
    assert.equal(r.deadline, 60000);
    assert.deepEqual(r.issues.map(i => i[1]).sort(), ["above_max", "below_min"]);
  });

  it("범위 밖 값은 그대로 쓰고 기록한다", () => {
    const r = load({ RATE_LIMIT_PER_IP: "-1", MEMENTO_CONFIG_STRICT: "true" });
    assert.equal(r.strict, true);
    assert.deepEqual(r.issues, [["RATE_LIMIT_PER_IP", "below_min", -1]]);
  });

  it("POSTGRES_PORT가 유효하면 DB_PORT는 읽지 않는다", () => {
    const r = load({ POSTGRES_PORT: "5433", DB_PORT: "abc" });
    assert.equal(r.dbPort, 5433);
    assert.deepEqual(r.issues, []);
  });

  it("POSTGRES_PORT가 없거나 숫자가 아니면 DB_PORT가 기본이다", () => {
    const a = load({ DB_PORT: "6000" });
    assert.equal(a.dbPort, 6000);
    assert.deepEqual(a.issues, []);
    const b = load({ POSTGRES_PORT: "abc", DB_PORT: "6001" });
    assert.equal(b.dbPort, 6001);
    assert.deepEqual(b.issues.map(i => i[0]), ["POSTGRES_PORT"]);
    const c = load({ DB_PORT: "abc" });
    assert.equal(c.dbPort, 5432);
    assert.deepEqual(c.issues.map(i => i[0]), ["DB_PORT"]);
  });

  it("기동 파일은 기록 뒤 엄격 모드에서 종료 코드 78로 멈춘다", () => {
    const server = readFileSync(new URL("../../server.js", import.meta.url), "utf8");
    assert.match(server, /getConfigIssues\(\)[\s\S]*CONFIG_STRICT[\s\S]*process\.exit\(78\)/);
  });
});

describe("호출 시점에 읽는 변수의 기동 검사", () => {
  const GARBAGE = {
    MEMENTO_SCORE_UPDATE_BATCH     : "-5",
    MEMENTO_SESSION_KEY_RECHECK_MS : "abc",
    DB_STATEMENT_TIMEOUT_MS        : "soon",
    MEMENTO_SEMANTIC_THRESHOLD_MODE: "sideways",
    MEMENTO_HEALTH_READY_DB_TIMEOUT_MS: "50"
  };

  const runServer = (extra) => {
    const logDir = mkdtempSync(path.join(tmpdir(), "memento-cfg-"));
    try {
      return spawnSync(process.execPath, ["server.js"], {
        cwd     : new URL("../../", import.meta.url),
        env     : {
          PATH: process.env.PATH, DOTENV_CONFIG_PATH: "/nonexistent.env", PORT: "19201",
          MEMENTO_ACCESS_KEY: "scratch", REDIS_ENABLED: "false", CACHE_ENABLED: "false",
          MEMENTO_METRICS_DEFAULT: "off", LOG_DIR: logDir, ...GARBAGE, ...extra
        },
        encoding: "utf8",
        timeout : 20000
      });
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  };

  it("엄격 모드에서 각 변수를 이름으로 지목하고 종료 코드 78로 멈춘다", () => {
    const r   = runServer({ MEMENTO_CONFIG_STRICT: "true" });
    const out = `${r.stdout}${r.stderr}`;
    assert.equal(r.status, 78);
    for (const name of Object.keys(GARBAGE)) assert.ok(out.includes(`${name}="`), `${name} 누락`);
    assert.match(out, /MEMENTO_HEALTH_READY_DB_TIMEOUT_MS="50" below_min, using default 2000/);
    assert.match(out, /MEMENTO_SCORE_UPDATE_BATCH="-5" below_min, using default 200/);
  });
});
