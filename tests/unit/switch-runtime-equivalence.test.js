/**
 * 스위치 대장과 사용처 판독의 일치 검사
 *
 * 스위치마다 여러 원시값(미설정, 빈 값, 공백, 대소문자, 잘못된 값, 문서 값)을 자식 프로세스의 환경에
 * 넣고, 실제 사용처가 읽은 값이 describeSwitches의 적용 값과 같은지 본다. 사용처가 모듈 상수나
 * 내보낸 함수로 값을 드러내는 스위치가 대상이다. 나머지 스위치는 사용처 소스에 판독 지점이 있고
 * 대장의 불리언 해석과 같은 비교식인지 소스로 본다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */

import { describe, it, before } from "node:test";
import assert                   from "node:assert/strict";
import { spawn }                from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path                     from "node:path";
import { fileURLToPath }        from "node:url";

import { SWITCHES, describeSwitches } from "../../config/switches.js";

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
 * 사용처가 호출 시점에 환경을 직접 비교하고 값을 모듈 밖으로 내보내지 않는 스위치.
 * 불리언은 소스의 비교식이 대장의 기본값과 맞는지 보고, 열거는 판독 지점의 존재만 본다.
 */
const SOURCE_ONLY = [
  "MEMENTO_TOOL_ARGS_VALIDATION", "MEMENTO_TOOL_ARGS_ALLOW_UNKNOWN", "MEMENTO_REMEMBER_ATOMIC", "MEMENTO_WORKSPACE_GATE",
  "MEMENTO_OAUTH_REDIRECT_CHECK", "MEMENTO_CORS_MODE", "MEMENTO_FRAME_OPTIONS", "MEMENTO_SSE_QUERY_KEY",
  "MEMENTO_VECTOR_FORCE_INDEX", "MEMENTO_ADMIN_METRICS_SAMPLING", "MEMENTO_METRICS_DEFAULT",
  "ENABLE_RECONSOLIDATION", "ENABLE_SPREADING_ACTIVATION", "UPDATE_REQUIRE_SIGNED_TAG"
];

/** 모든 스위치에 공통으로 넣는 원시값. undefined는 미설정이다. */
const COMMON_RAW = [undefined, "", " ", "true", "false", "TRUE", "False", "1", "yes", " true", "garbage", "on", "off"];

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
    assert.deepEqual(rest, [...SOURCE_ONLY].sort(), "판독 식이 없는 스위치와 소스 검사 목록이 다르다");
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

  it("후보 원시값이 미설정과 잘못된 값과 허용 값을 모두 포함한다", () => {
    for (const spec of covered) {
      const list = candidates(spec);
      assert.ok(list.includes(undefined), spec.name);
      assert.ok(list.includes("garbage"), spec.name);
      if (spec.kind === "enum") for (const v of spec.values) assert.ok(list.includes(v), `${spec.name} ${v}`);
    }
  });
});

/** 디렉터리 아래 .js 파일을 재귀로 모은다. */
function listJs(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJs(full));
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

describe("소스에서만 확인하는 스위치", () => {
  const files  = [...listJs(path.join(ROOT, "lib")), ...listJs(path.join(ROOT, "config")), path.join(ROOT, "server.js")];
  const source = files.map((f) => readFileSync(f, "utf8")).join("\n");

  for (const name of SOURCE_ONLY) {
    const spec = SWITCHES.find((s) => s.name === name);
    it(`${name}의 판독 지점이 소스에 있다`, () => {
      assert.ok(spec, `${name}은 대장에 없다`);
      assert.match(source, new RegExp(`process\\.env\\.${name}\\b`));
    });

    if (spec?.kind === "boolean") {
      it(`${name}의 비교식이 대장의 기본값과 맞다`, () => {
        const eq  = new RegExp(`process\\.env\\.${name}\\s*===\\s*"true"`);
        const neq = new RegExp(`process\\.env\\.${name}\\s*!==\\s*"(true|false)"`);
        const m   = source.match(spec.default ? /$^/ : eq) ?? source.match(neq);
        assert.ok(m, `${name}의 비교식을 찾지 못했다`);
        if (spec.default) assert.match(m[0], /!==\s*"false"/);
        else assert.ok(/===\s*"true"/.test(m[0]) || /!==\s*"true"/.test(m[0]));
      });
    }
  }
});
