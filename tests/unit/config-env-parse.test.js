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

  it("형식이 틀린 MEMENTO_ADMIN_SEAL_KEY는 값 없이 기록되고 봉인 키를 쓰지 않는다", () => {
    const secretLike = "v1:c2hvcnQta2V5LXZhbHVl";
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", `
      const c = await import("./lib/config.js");
      console.log(JSON.stringify({ ring: c.adminSealKeyRing(), issues: c.getConfigIssues() }));
    `], {
      cwd: new URL("../../", import.meta.url),
      env: { PATH: process.env.PATH, DOTENV_CONFIG_PATH: "/nonexistent.env", MEMENTO_ADMIN_SEAL_KEY: secretLike },
      encoding: "utf8"
    });
    const r = JSON.parse(out);
    assert.equal(r.ring, null);
    assert.deepEqual(r.issues.map(i => [i.name, i.problem, i.value]), [["MEMENTO_ADMIN_SEAL_KEY", "key_length", "(hidden)"]]);
    assert.ok(!out.includes("c2hvcnQta2V5LXZhbHVl"));
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
    MEMENTO_HEALTH_READY_DB_TIMEOUT_MS: "50",
    MEMENTO_LLM_CLI_TOOL_APPROVAL  : "maybe",
    MEMENTO_SESSION_ID_POLICY      : "strict",
    MEMENTO_ADMIN_AUTH_BACKOFF     : "yes",
    MEMENTO_REMEMBER_DUPLICATE_GUARD: "1",
    MEMENTO_API_KEY_DELETE_GUARD   : "off",
    MEMENTO_TOOL_ARGS_VALIDATION   : "loud"
  };

  const runServer = (extra) => {
    const logDir = mkdtempSync(path.join(tmpdir(), "memento-cfg-"));
    try {
      return spawnSync(process.execPath, ["server.js"], {
        cwd     : new URL("../../", import.meta.url),
        env     : {
          PATH: process.env.PATH, DOTENV_CONFIG_PATH: "/nonexistent.env", PORT: "0",
          POSTGRES_HOST: "127.0.0.1", POSTGRES_PORT: "1",
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

  const SWITCHES = {
    MEMENTO_LLM_CLI_TOOL_APPROVAL   : "maybe",
    MEMENTO_SESSION_ID_POLICY       : "strict",
    MEMENTO_ADMIN_AUTH_BACKOFF      : "yes",
    MEMENTO_REMEMBER_DUPLICATE_GUARD: "1",
    MEMENTO_API_KEY_DELETE_GUARD    : "off",
    MEMENTO_TOOL_ARGS_VALIDATION    : "loud"
  };

  const probe = (env) => JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `
    const c  = await import("./lib/config.js");
    const a  = await import("./lib/llm/util/cli-approval.js");
    const k  = await import("./lib/admin/ApiKeyStore.js");
    const h  = await import("./lib/handlers/sse-handler.js");
    console.log("PROBE " + JSON.stringify({
      approval: a.cliToolApprovalMode(), session: c.sessionIdPolicy(), backoff: c.adminAuthBackoffMode(),
      dup: c.isRememberDuplicateGuardEnabled(), del: k.isApiKeyDeleteGuardEnabled(),
      sse: h.legacySseQueryKeyMode(),
      issues: c.getConfigIssues().map(i => [i.name, i.problem, i.used])
    }));
  `], {
    cwd: new URL("../../", import.meta.url),
    env: {
      PATH: process.env.PATH, DOTENV_CONFIG_PATH: "/nonexistent.env", POSTGRES_HOST: "127.0.0.1", POSTGRES_PORT: "1",
      REDIS_ENABLED: "false", CACHE_ENABLED: "false", MEMENTO_METRICS_DEFAULT: "off", ...env
    },
    encoding: "utf8"
  }).split("\n").find(line => line.startsWith("PROBE ")).slice(6));

  it("문서 밖 값은 변수 이름으로 기록하고 적용 값은 그대로 둔다", () => {
    const r = probe(SWITCHES);
    assert.deepEqual(r.issues.map(i => i[0]).sort(), Object.keys(SWITCHES).sort());
    assert.ok(r.issues.every(i => i[1] === "not_in_enum"));
    assert.equal(r.approval, "none");
    assert.equal(r.session, "warn");
    assert.equal(r.backoff, "off");
    assert.equal(r.dup, false);
    assert.equal(r.del, true);
  });

  /** [이름, 문서 밖 값, 사용처가 그 값에 적용하는 값, 문서에 있는 값] */
  const ENUM_SWITCHES = [
    ["MEMENTO_OAUTH_REDIRECT_CHECK", "block",      "warn",    ["warn", "enforce"]],
    ["MEMENTO_CORS_MODE",           "open",       "observe", ["reflect", "observe", "allowlist"]],
    ["MEMENTO_FRAME_OPTIONS",       "sameorigin", "off",     ["deny"]],
    ["MEMENTO_SSE_QUERY_KEY",       "block",      "allow",   ["allow", "deny"]]
  ];

  /** [이름, 사용처가 문서 밖 값에 적용하는 값]. 문서에 있는 값은 true와 false다. */
  const BOOL_SWITCHES = [
    ["MEMENTO_REMEMBER_ATOMIC",                    false],
    ["MEMENTO_WORKSPACE_GATE",                     false],
    ["MEMENTO_TOOL_ARGS_ALLOW_UNKNOWN",            false],
    ["ENABLE_RECONSOLIDATION",                     false],
    ["ENABLE_SPREADING_ACTIVATION",                false],
    ["UPDATE_REQUIRE_SIGNED_TAG",                  false],
    ["MEMENTO_AUTH_DISABLED",                      false],
    ["REDIS_ENABLED",                              false],
    ["REDIS_SENTINEL_ENABLED",                     false],
    ["MEMENTO_REDIS_SESSION_FAIL_CLOSED",          false],
    ["CACHE_ENABLED",                              false],
    ["EMBEDDING_SUPPORTS_DIMS_PARAM",              false],
    ["MEMENTO_RERANKER_ENABLED",                   false],
    ["MEMENTO_CASE_BACKPROP_ENABLED",              false],
    ["UPDATE_CHECK_DISABLED",                      false],
    ["ENABLE_OPENAPI",                             false],
    ["MCP_ALLOW_AUTO_DCR_REGISTER",                false],
    ["MCP_STRICT_ORIGIN",                          false],
    ["MEMENTO_ALLOW_LEGACY_UNBOUND_AGENT_SCOPE",   true],
    ["LLM_CONCURRENCY_ENABLED",                    true],
    ["MCP_REJECT_NONAPIKEY_OAUTH",                 true]
  ];

  it("열거형 스위치의 문서 밖 값은 기록하고 사용처가 적용하는 값을 남긴다", () => {
    const r = probe(Object.fromEntries(ENUM_SWITCHES.map(([n, bad]) => [n, bad])));
    assert.deepEqual(r.issues.map(i => i[0]).sort(), ENUM_SWITCHES.map(e => e[0]).sort());
    for (const [name, , used] of ENUM_SWITCHES) {
      const issue = r.issues.find(i => i[0] === name);
      assert.equal(issue[1], "not_in_enum");
      assert.equal(issue[2], used, `${name} 적용 값`);
    }
    assert.equal(r.sse, "allow");
  });

  it("논리 스위치의 true와 false 밖 값은 기록하고 사용처가 적용하는 값을 남긴다", () => {
    const r = probe(Object.fromEntries(BOOL_SWITCHES.map(([n]) => [n, "yes"])));
    assert.deepEqual(r.issues.map(i => i[0]).sort(), BOOL_SWITCHES.map(e => e[0]).sort());
    for (const [name, used] of BOOL_SWITCHES) {
      const issue = r.issues.find(i => i[0] === name);
      assert.equal(issue[1], "not_boolean");
      assert.equal(issue[2], used, `${name} 적용 값`);
    }
  });

  it("스위치의 문서에 있는 값과 빈 값은 기록하지 않는다", () => {
    const rounds = [0, 1, 2].map(i => Object.fromEntries(ENUM_SWITCHES.map(([n, , , doc]) => [n, doc[i % doc.length]])));
    /** Redis 스위치를 true로 두면 자식 프로세스가 로컬 Redis에 닿을 수 있어 true 값 점검에서 뺀다. */
    const bools = (v) => Object.fromEntries(BOOL_SWITCHES
      .filter(([n]) => v !== "true" || !/^(REDIS_|CACHE_)/.test(n)).map(([n]) => [n, v]));
    for (const env of [...rounds, ...["true", "false", ""].map(bools),
      Object.fromEntries(ENUM_SWITCHES.map(([n]) => [n, " "]))]) {
      assert.deepEqual(probe(env).issues, [], JSON.stringify(env));
    }
  });

  it("문서에 있는 값과 빈 값은 기록하지 않고 적용 값이 그대로다", () => {
    const r = probe({
      MEMENTO_LLM_CLI_TOOL_APPROVAL: "all", MEMENTO_SESSION_ID_POLICY: "enforce", MEMENTO_ADMIN_AUTH_BACKOFF: "on",
      MEMENTO_REMEMBER_DUPLICATE_GUARD: "true", MEMENTO_API_KEY_DELETE_GUARD: "false", MEMENTO_TOOL_ARGS_VALIDATION: "off"
    });
    assert.deepEqual(r.issues, []);
    assert.equal(r.approval, "all");
    assert.equal(r.session, "enforce");
    assert.equal(r.backoff, "on");
    assert.equal(r.dup, true);
    assert.equal(r.del, false);
    const blank = probe({ MEMENTO_SESSION_ID_POLICY: "", MEMENTO_ADMIN_AUTH_BACKOFF: "  " });
    assert.deepEqual(blank.issues, []);
  });

  it("엄격 모드에서 각 변수를 이름으로 지목하고 종료 코드 78로 멈춘다", () => {
    const r   = runServer({ MEMENTO_CONFIG_STRICT: "true" });
    const out = `${r.stdout}${r.stderr}`;
    assert.equal(r.status, 78);
    for (const name of Object.keys(GARBAGE)) assert.ok(out.includes(`${name}="`), `${name} 누락`);
    assert.match(out, /MEMENTO_HEALTH_READY_DB_TIMEOUT_MS="50" below_min, using default 2000/);
    assert.match(out, /MEMENTO_SCORE_UPDATE_BATCH="-5" below_min, using default 200/);
  });
});
