/**
 * 스위치 대장과 사용처 판독의 일치 검사
 *
 * 스위치마다 여러 원시값(미설정, 빈 값, 공백, 대소문자, 잘못된 값, 문서 값)을 넣고 실제 사용처가 읽은 값이
 * describeSwitches의 적용 값과 같은지 본다. 모든 스위치가 대상이다.
 *   1. 사용처가 모듈 상수나 내보낸 함수로 값을 드러내는 57개: 자식 프로세스의 환경에 원시값을 넣고 읽은 값을 비교한다.
 *   2. 호출 시점에 읽는 열거 8개와 리터럴 true 불리언 5개: 사용처가 부르는 lib/env-parse.js의 판독 함수와
 *      대장을 같은 원시값 표로 비교하고, 사용처가 그 함수를 부르며 환경을 직접 비교하지 않는지 소스로 본다.
 *   3. 잘못된 값 표시: 환경 변수 도우미(envBool, envEnum)로도 읽는 스위치는 기동 시 설정 문제 목록과, 기동 실패로
 *      이어지는 값은 판독 결과와, 그 밖의 모든 스위치는 문서 값 집합에서 독립적으로 계산한 기대값과 비교한다.
 */

import { describe, it, before } from "node:test";
import assert                   from "node:assert/strict";
import { spawn }                from "node:child_process";
import { readFileSync } from "node:fs";
import path                     from "node:path";
import { fileURLToPath }        from "node:url";

import { SWITCHES, describeSwitches } from "../../config/switches.js";
import * as readers                    from "../../lib/env-parse.js";
import { helperReadNames, listJs }     from "./switch-source-helpers.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * 사용처가 값을 드러내는 스위치의 판독 식. 자식 프로세스에서 모듈을 가져온 뒤 평가한다.
 * 값이 불리언이나 열거 문자열이 아니면 변환 식으로 대장의 값과 같은 형태로 맞춘다.
 */
const RUNTIME = {
  MEMENTO_AUTH_DISABLED:                    "cfg.AUTH_DISABLED",
  MEMENTO_ALLOW_LEGACY_UNBOUND_AGENT_SCOPE: "cfg.ALLOW_LEGACY_UNBOUND_AGENT_SCOPE",
  MEMENTO_RESERVED_AGENT_IDS:               "cfg.reservedAgentIdsMode()",
  MEMENTO_ADMIN_AUTH_BACKOFF:               "cfg.adminAuthBackoffMode()",
  MEMENTO_API_KEY_DELETE_GUARD:             "keys.isApiKeyDeleteGuardEnabled()",
  MEMENTO_REDIS_SESSION_FAIL_CLOSED:        "cfg.REDIS_SESSION_FAIL_CLOSED",
  MEMENTO_SESSION_ID_POLICY:                "cfg.sessionIdPolicy()",
  MCP_STRICT_ORIGIN:                        "cfg.STRICT_ORIGIN",
  MCP_ALLOW_AUTO_DCR_REGISTER:              "cfg.ALLOW_AUTO_DCR_REGISTER",
  MCP_REJECT_NONAPIKEY_OAUTH:               "cfg.REJECT_NONAPIKEY_OAUTH",
  ENABLE_OPENAPI:                           "cfg.ENABLE_OPENAPI",
  MEMENTO_REMEMBER_DUPLICATE_GUARD:         "cfg.isRememberDuplicateGuardEnabled()",
  MEMENTO_WORKSPACE_GATE:                   "cfg.workspaceGateEnforced()",
  MEMENTO_WRITE_GATE:                       "cfg.writeGateEnabled() ? 'on' : 'off'",
  MEMENTO_SENSITIVE_SCAN:                   "cfg.sensitiveScanMode()",
  MEMENTO_WM_PG_FALLBACK:                   "cfg.wmPgFallbackEnabled() ? 'on' : 'off'",
  MEMENTO_DEDUP_SCOPE:                      "cfg.dedupScope()",
  MEMENTO_RANK_BEFORE_BUDGET:               "cfg.rankBeforeBudgetEnabled() ? 'on' : 'off'",
  MEMENTO_GC_THROUGHPUT:                    "cfg.gcThroughputEnabled() ? 'on' : 'off'",
  MEMENTO_CONTEXT_ANNOTATE:                 "cfg.contextAnnotateEnabled() ? 'on' : 'off'",
  MEMENTO_PROVENANCE:                       "cfg.provenanceEnabled() ? 'on' : 'off'",
  MEMENTO_REVIEW_QUEUE:                     "cfg.reviewQueueEnabled() ? 'on' : 'off'",
  MEMENTO_LOG_STDERR:                       "cfg.logToStderr()",
  MEMENTO_OUTBOX:                           "cfg.outboxEnabled() ? 'on' : 'off'",
  MEMENTO_OUTBOX_WORKER:                    "cfg.outboxWorkerEnabled() ? 'on' : 'off'",
  MEMENTO_HOOK_ENDPOINTS:                   "cfg.hookEndpointsEnabled() ? 'on' : 'off'",
  REDIS_ENABLED:                            "cfg.REDIS_ENABLED",
  REDIS_SENTINEL_ENABLED:                   "cfg.REDIS_SENTINEL_ENABLED",
  CACHE_ENABLED:                            "cfg.CACHE_ENABLED",
  MEMENTO_RERANKER_ENABLED:                 "cfg.RERANKER_ENABLED",
  MEMENTO_CASE_BACKPROP_ENABLED:            "cfg.CASE_BACKPROP_ENABLED",
  MEMENTO_CONFIG_STRICT:                    "cfg.CONFIG_STRICT",
  UPDATE_CHECK_DISABLED:                    "cfg.UPDATE_CHECK_DISABLED",
  LLM_CONCURRENCY_ENABLED:                  "cfg.LLM_CONCURRENCY_ENABLED",
  MEMENTO_LLM_CLI_TOOL_APPROVAL:            "approval.cliToolApprovalMode()",
  MEMENTO_QUERY_PROFILE_ENABLED:            "profile.isProfileEnabled()",
  MEMENTO_AUTO_PROMOTE_ANCHORS:             "typeof mem.consolidate.autoPromoteAnchors === 'boolean' ? mem.consolidate.autoPromoteAnchors : 'invalid'",
  MEMENTO_SYNTHETIC_QUERY_ENABLED:          "mem.syntheticQuery.enabled",
  MEMENTO_SYNTHETIC_QUERY_SEARCH:           "mem.syntheticQuery.searchEnabled",
  MEMENTO_KEYWORD_SEMANTIC_FALLBACK:        "mem.semanticSearch.keywordFallback",
  MEMENTO_CONSOLIDATE_SPLIT_LONG:           "mem.consolidate.enableRiskyStages.splitLongFragments",
  MEMENTO_CONSOLIDATE_DETECT_CONTRADICT:    "mem.consolidate.enableRiskyStages.detectContradictions",
  MEMENTO_CONSOLIDATE_COMPRESS_OLD:         "mem.consolidate.enableRiskyStages.compressOldFragments",
  MEMENTO_SPLIT_SUBJECT_GATE:               "mem.fragmentSplit.requireSubjectAnchor",
  MEMENTO_SPLIT_MODALITY_GATE:              "mem.fragmentSplit.rejectIntroducedModality",
  MEMENTO_FEEDBACK_SAMPLING:                "mem.feedback.sampling.enabled",
  MEMENTO_ENABLE_KUROMOJI:                  "mem.morphemeIndex.enableKuromoji",
  MEMENTO_WORKSPACE_DECAY:                  "mem.workspaceDecay.enabled",
  MEMENTO_SESSION_SEGMENT:                  "mem.sessionSegment.enabled",
  MEMENTO_PROACTIVE_RECALL_MODE:            "mem.proactiveRecall.mode === 'off' ? 'off' : mem.proactiveRecall.mode === 'legacy' ? 'legacy' : 'auto'",
  MEMENTO_SYMBOLIC_ENABLED:                 "sym.enabled",
  MEMENTO_SYMBOLIC_SHADOW:                  "sym.shadow",
  MEMENTO_SYMBOLIC_CLAIM_EXTRACTION:        "sym.claimExtraction",
  MEMENTO_SYMBOLIC_EXPLAIN:                 "sym.explain",
  MEMENTO_SYMBOLIC_LINK_CHECK:              "sym.linkCheck",
  MEMENTO_SYMBOLIC_POLARITY_CONFLICT:       "sym.polarityConflict",
  MEMENTO_SYMBOLIC_POLICY_RULES:            "sym.policyRules",
  MEMENTO_SYMBOLIC_CBR_FILTER:              "sym.cbrFilter",
  MEMENTO_SYMBOLIC_PROACTIVE_GATE:          "sym.proactiveGate"
};

/**
 * 사용처가 호출 시점에 isLiteralTrue(env, 이름)으로 읽고 값을 모듈 밖으로 내보내지 않는 불리언 스위치.
 */
const LITERAL_TRUE = [
  "MEMENTO_TOOL_ARGS_ALLOW_UNKNOWN", "MEMENTO_REMEMBER_ATOMIC",
  "ENABLE_RECONSOLIDATION", "ENABLE_SPREADING_ACTIVATION", "UPDATE_REQUIRE_SIGNED_TAG"
];

/**
 * 호출 시점에 열거를 읽는 스위치와 사용처가 부르는 판독 함수. 판독 함수는 lib/env-parse.js에 있다.
 */
const ENUM_READERS = {
  MEMENTO_TOOL_ARGS_VALIDATION:   "readToolArgsValidation",
  MEMENTO_OAUTH_REDIRECT_CHECK:   "readOauthRedirectCheck",
  MEMENTO_CORS_MODE:              "readCorsMode",
  MEMENTO_FRAME_OPTIONS:          "readFrameOptions",
  MEMENTO_SSE_QUERY_KEY:          "readSseQueryKey",
  MEMENTO_VECTOR_FORCE_INDEX:     "readVectorForceIndex",
  MEMENTO_ADMIN_METRICS_SAMPLING: "readAdminMetricsSampling",
  MEMENTO_METRICS_DEFAULT:        "readMetricsDefault"
};

/** 모든 스위치에 공통으로 넣는 원시값. undefined는 미설정이다. */
const COMMON_RAW = [undefined, "", " ", "true", "false", "TRUE", "False", "1", "yes", " true", "garbage", "on", "off"];

/** 판독 함수와 대장의 직접 비교에 쓰는 원시값 표. 공통 값에 탭, 대소문자 혼합, 열거 값을 더했다. */
const RAW_TABLE = [...new Set([...COMMON_RAW, "\t", "Deny", "DENY", "Enforce", " enforce", " off", "Off", "warn", "enforce",
  "reflect", "observe", "allowlist", "allow", "deny", "none", "all"])];

/** 스위치 하나에 대한 원시값 표: 공통 표에 그 스위치의 문서 값을 더한다. */
const rawTableFor = (spec) => [...new Set([...RAW_TABLE, ...(spec.values ?? [])])];

/** 원시값 하나로 이루어진 환경. undefined는 빈 환경이다. */
const envOf = (name, raw) => (raw === undefined ? {} : { [name]: raw });

const CHILD_HEAD = `
const root = ${JSON.stringify(ROOT)};
const load = (p) => import(root + "/" + p);
const cfg = await load("lib/config.js");
const keys = await load("lib/admin/ApiKeyStore.js");
const approval = await load("lib/llm/util/cli-approval.js");
const profile = await load("lib/memory/read/QueryProfile.js");
const mem = (await load("config/memory.js")).MEMORY_CONFIG;
const sym = (await load("config/symbolic.js")).SYMBOLIC_CONFIG;
const out = {};
`;

const CHILD_TAIL = `
out.__issues = cfg.getConfigIssues().map((i) => i.name).join(",");
process.stdout.write("\\n@@" + JSON.stringify(out) + "\\n");
process.exit(0);
`;

/** 판독 식 표에서 자식 프로세스 스크립트를 만든다. 식은 이 파일의 상수 문자열이다. */
const CHILD_SCRIPT = CHILD_HEAD
  + Object.entries(RUNTIME).map(([name, expr]) => `out[${JSON.stringify(name)}] = String(${expr});`).join("\n")
  + CHILD_TAIL;

/** 스위치 하나의 후보 원시값 목록 */
function candidates(spec) {
  const extra = spec.kind === "enum" ? [...spec.values, spec.default] : [];
  return [...new Set([...COMMON_RAW, ...extra])];
}

/** 자식 프로세스 하나를 실행해 사용처가 읽은 값을 돌려준다. */
function probe(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", CHILD_SCRIPT], {
      cwd: ROOT,
      env: {
        PATH                : process.env.PATH,
        DOTENV_CONFIG_PATH  : "/nonexistent/switch-probe.env",
        DOTENV_CONFIG_QUIET : "true",
        MEMENTO_METRICS_DEFAULT: "off",
        ...env
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", reject);
    child.on("close", (code) => {
      const line = stdout.split("\n").find((l) => l.startsWith("@@"));
      if (code !== 0 || !line) return reject(new Error(`probe 실패 code=${code}\n${stderr.slice(-800)}`));
      resolve(JSON.parse(line.slice(2)));
    });
  });
}

describe("스위치 대장과 사용처 판독", () => {
  const covered = SWITCHES.filter((s) => RUNTIME[s.name] !== undefined);
  const rounds  = Math.max(...SWITCHES.map((s) => candidates(s).length));
  let   results;

  before(async () => {
    const envs = Array.from({ length: rounds }, (_, k) => {
      const env = {};
      for (const spec of SWITCHES) {
        const list = candidates(spec);
        const raw  = list[k % list.length];
        if (raw !== undefined) env[spec.name] = raw;
      }
      return env;
    });
    results = await Promise.all(envs.map(async (env) => ({ env, runtime: await probe(env) })));
  });

  it("사용처 판독 식이 대장의 스위치와 겹치지 않거나 빠지지 않는다", () => {
    const names = new Set(SWITCHES.map((s) => s.name));
    for (const name of Object.keys(RUNTIME)) assert.ok(names.has(name), `${name}은 대장에 없다`);
    const rest = SWITCHES.filter((s) => RUNTIME[s.name] === undefined).map((s) => s.name).sort();
    const expected = [...LITERAL_TRUE, ...Object.keys(ENUM_READERS)].sort();
    assert.deepEqual(rest, expected, "판독 식이 없는 스위치와 판독 함수 목록이 다르다");
  });

  it("모든 원시값에서 사용처가 읽은 값이 대장의 적용 값과 같다", () => {
    const wrong = [];
    for (const { env, runtime } of results) {
      const states = describeSwitches(env);
      for (const spec of covered) {
        const state = states.find((s) => s.name === spec.name);
        const got   = runtime[spec.name];
        const want  = state.state === "invalid" ? "invalid" : state.value;
        if (got !== want) wrong.push(`${spec.name} raw=${JSON.stringify(env[spec.name])} 사용처=${got} 대장=${want}`);
      }
    }
    assert.deepEqual(wrong, []);
  });

  it("도우미로도 읽는 스위치는 대장이 잘못된 값으로 본 집합이 기동 시 설정 문제 목록과 같다", () => {
    const helperNames = helperReadNames(readFileSync(path.join(ROOT, "lib", "config.js"), "utf8"));
    const both        = new Set(SWITCHES.map((s) => s.name).filter((n) => helperNames.has(n)));
    assert.ok(both.size >= 20, `대상이 ${both.size}개뿐이다`);
    const wrong = [];
    for (const { env, runtime } of results) {
      const issues = new Set(runtime.__issues.split(",").filter((n) => both.has(n)));
      const ledger = new Set(describeSwitches(env).filter((s) => s.invalid && both.has(s.name)).map((s) => s.name));
      for (const name of both) {
        if (issues.has(name) !== ledger.has(name)) {
          wrong.push(`${name} raw=${JSON.stringify(env[name])} 설정 문제 목록=${issues.has(name)} 대장=${ledger.has(name)}`);
        }
      }
    }
    assert.deepEqual(wrong, []);
  });

  it("후보 원시값이 미설정과 잘못된 값과 허용 값을 모두 포함한다", () => {
    for (const spec of covered) {
      const list = candidates(spec);
      assert.ok(list.includes(undefined), spec.name);
      assert.ok(list.includes("garbage"), spec.name);
      if (spec.kind === "enum") for (const v of spec.values) assert.ok(list.includes(v), `${spec.name} ${v}`);
    }
  });
});

/** lib, config, server.js의 소스. 판독 함수를 정의한 lib/env-parse.js는 뺀다. */
const callSiteSource = () => [
  ...listJs(path.join(ROOT, "lib")), ...listJs(path.join(ROOT, "config")), path.join(ROOT, "server.js")
].filter((f) => !f.endsWith(path.join("lib", "env-parse.js"))).map((f) => readFileSync(f, "utf8")).join("\n");

describe("호출 시점에 리터럴 true를 읽는 불리언 스위치", () => {
  const source = callSiteSource();

  for (const name of LITERAL_TRUE) {
    it(`${name}: 사용처가 isLiteralTrue로 읽고 환경을 직접 비교하지 않는다`, () => {
      assert.match(source, new RegExp(`isLiteralTrue\\(process\\.env,\\s*"${name}"\\)`));
      assert.doesNotMatch(source, new RegExp(`process\\.env\\.${name}\\b`));
    });

    it(`${name}: 모든 원시값에서 판독 값이 대장의 적용 값과 같다`, () => {
      const spec  = SWITCHES.find((s) => s.name === name);
      const wrong = [];
      for (const raw of rawTableFor(spec)) {
        const env   = envOf(name, raw);
        const state = describeSwitches(env).find((s) => s.name === name);
        const got   = String(readers.isLiteralTrue(env, name));
        if (got !== state.value) wrong.push(`raw=${JSON.stringify(raw)} 판독=${got} 대장=${state.value}`);
      }
      assert.deepEqual(wrong, []);
    });
  }
});

describe("호출 시점에 열거를 읽는 스위치", () => {
  const source = callSiteSource();

  for (const [name, fn] of Object.entries(ENUM_READERS)) {
    it(`${name}: 사용처가 ${fn}으로 읽고 환경을 직접 비교하지 않는다`, () => {
      assert.match(source, new RegExp(`${fn}\\(process\\.env\\)`));
      assert.doesNotMatch(source, new RegExp(`process\\.env\\.${name}\\b`));
    });

    it(`${name}: 모든 원시값에서 판독 함수의 값이 대장의 적용 값과 같다`, () => {
      assert.equal(typeof readers[fn], "function", fn);
      const wrong = [];
      const spec  = SWITCHES.find((s) => s.name === name);
      for (const raw of rawTableFor(spec)) {
        const env   = envOf(name, raw);
        const state = describeSwitches(env).find((s) => s.name === name);
        const got   = readers[fn](env);
        if (got !== state.value) wrong.push(`raw=${JSON.stringify(raw)} 판독=${got} 대장=${state.value}`);
      }
      assert.deepEqual(wrong, []);
    });
  }
});

/**
 * 문서 값 집합에서 독립적으로 계산한 "잘못된 값" 기대값. 불리언은 true와 false, 열거는 문서 값만 유효하다.
 * 미설정과 공백만 있는 값은 미설정이다(emptyOnly는 빈 문자열만, strictBlank는 미설정만).
 * 항목의 trim, ci 속성은 사용처가 읽는 방식 그대로 적용한다. off-disables는 잘못된 값이 없다.
 */
function expectedInvalid(spec, raw) {
  if (spec.kind === "off-disables" || raw === undefined) return false;
  let text = raw;
  if (spec.trim) text = text.trim();
  if (spec.ci)   text = text.toLowerCase();
  const blank = spec.emptyOnly ? text === "" : text.trim() === "";
  if (blank) return Boolean(spec.strictBlank) && !(spec.emptyOnly);
  const documented = spec.kind === "boolean" ? ["true", "false"] : spec.values;
  return !documented.includes(text);
}

describe("모든 스위치의 잘못된 값 표시", () => {
  it("모든 스위치와 원시값 표에서 대장의 invalid가 문서 값 집합의 기대값과 같다", () => {
    const wrong = [];
    for (const spec of SWITCHES) {
      for (const raw of rawTableFor(spec)) {
        const state = describeSwitches(envOf(spec.name, raw)).find((s) => s.name === spec.name);
        if (state.invalid !== expectedInvalid(spec, raw)) {
          wrong.push(`${spec.name} raw=${JSON.stringify(raw)} 대장=${state.invalid} 기대=${expectedInvalid(spec, raw)}`);
        }
      }
    }
    assert.deepEqual(wrong, []);
  });

  it("잘못된 값의 적용 값은 문서 기본값 또는 사용처가 적용하는 값이고 잘못된 원본은 담기지 않는다", () => {
    for (const spec of SWITCHES) {
      const state = describeSwitches(envOf(spec.name, "garbage_SECRET_value")).find((s) => s.name === spec.name);
      assert.ok(!JSON.stringify(state).includes("garbage_SECRET_value"), spec.name);
      if (state.invalid && state.state !== "invalid") {
        const applied = spec.invalid ?? spec.default;
        const given   = spec.follows ? state.default : String(applied);
        assert.equal(state.value, given, spec.name);
      }
    }
  });
});
