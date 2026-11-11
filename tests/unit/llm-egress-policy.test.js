/**
 * 외부 전송 정책 판정 순수 함수 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */
import { describe, it } from "node:test";
import assert           from "node:assert/strict";

const {
  EXTERNAL_DEFAULT_STAGES,
  KNOWN_STAGES,
  STAGE_DEFAULT,
  stageDefaultLocalOnly,
  classifyProvider,
  validateEgressPolicy,
  resolveEgressRule,
  decideEgress,
  evaluateEgress,
  stageLabel,
  EgressPolicyValidationError,
  EgressSkippedError,
  MAX_APPROVED_PROVIDERS,
  MAX_POLICY_WORKSPACES
} = await import("../../lib/llm/EgressPolicy.js");

const KNOWN = ["ollama", "vllm", "openai", "anthropic", "gemini-cli", "codex-cli"];

function rejects(value, path) {
  assert.throws(
    () => validateEgressPolicy(value, { knownProviders: KNOWN }),
    (err) => err instanceof EgressPolicyValidationError && err.path === path,
    `${JSON.stringify(value)} 은 ${path} 오류여야 한다`
  );
}

describe("classifyProvider", () => {
  it("루프백 주소의 HTTP 제공자는 로컬이다", () => {
    for (const baseUrl of [
      "http://localhost:11434", "http://127.0.0.1:8000/v1", "http://127.9.8.7", "http://[::1]:8000",
      "http://LOCALHOST:1", "http://[::ffff:127.0.0.1]:8000"
    ]) {
      assert.equal(classifyProvider({ name: "ollama", baseUrl }), "local", baseUrl);
    }
  });

  it("그 밖의 주소, 주소 없음, 해석할 수 없는 주소는 외부다", () => {
    for (const baseUrl of ["https://api.openai.com/v1", "http://gpu-box:11434", "http://128.0.0.1", "http://api.localhost:3000",
      "http://localhost.example.com", null, undefined, "", "not a url"]) {
      assert.equal(classifyProvider({ name: "vllm", baseUrl }), "external", String(baseUrl));
    }
  });

  it("CLI 제공자는 주소와 관계없이 외부다", () => {
    for (const name of ["gemini-cli", "agy-cli", "codex-cli", "copilot-cli", "qwen-cli", "opencode-cli"]) {
      assert.equal(classifyProvider({ name, baseUrl: "http://localhost" }), "external", name);
    }
  });

  it("운영자가 지정한 호스트는 로컬이다(대소문자 무시)", () => {
    assert.equal(classifyProvider({ name: "ollama", baseUrl: "http://GPU-box:11434" }, ["gpu-box"]), "local");
    assert.equal(classifyProvider({ name: "ollama", baseUrl: "http://gpu-box2:11434" }, ["gpu-box"]), "external");
  });

  it("설정 객체 안의 baseUrl도 읽는다", () => {
    assert.equal(classifyProvider({ name: "openai", config: { baseUrl: "http://127.0.0.1:1234/v1" } }), "local");
  });
});

describe("validateEgressPolicy", () => {
  it("null은 정책 없음이다", () => {
    assert.equal(validateEgressPolicy(null, { knownProviders: KNOWN }), null);
  });

  it("정규화된 정책을 돌려준다", () => {
    const out = validateEgressPolicy({
      local_only        : false,
      approved_providers: ["anthropic", "anthropic", "ollama"],
      workspaces        : { team: { local_only: true }, open: { approved_providers: null } }
    }, { knownProviders: KNOWN });
    assert.deepEqual(out, {
      local_only        : false,
      approved_providers: ["anthropic", "ollama"],
      workspaces        : { team: { local_only: true }, open: { approved_providers: null } }
    });
  });

  it("빈 객체는 빈 정책이다", () => {
    assert.deepEqual(validateEgressPolicy({}, { knownProviders: KNOWN }), {});
  });

  it("형태가 맞지 않으면 경로와 함께 거부한다", () => {
    rejects([], "egress_policy");
    rejects("local_only", "egress_policy");
    rejects({ mode: "x" }, "egress_policy.mode");
    rejects({ local_only: "yes" }, "egress_policy.local_only");
    rejects({ approved_providers: "anthropic" }, "egress_policy.approved_providers");
    rejects({ approved_providers: ["nope"] }, "egress_policy.approved_providers");
    rejects({ approved_providers: [1] }, "egress_policy.approved_providers");
    rejects({ workspaces: [] }, "egress_policy.workspaces");
    rejects({ workspaces: { " a": {} } }, "egress_policy.workspaces");
    rejects({ workspaces: { "a\u0000": {} } }, "egress_policy.workspaces");
    rejects({ workspaces: { a: null } }, "egress_policy.workspaces.a");
    rejects({ workspaces: { a: { workspaces: {} } } }, "egress_policy.workspaces.a.workspaces");
    rejects({ workspaces: { a: { local_only: 1 } } }, "egress_policy.workspaces.a.local_only");
  });

  it("상한을 넘는 목록은 거부한다", () => {
    const many = Array.from({ length: MAX_APPROVED_PROVIDERS + 1 }, (_, i) => `p${i}`);
    rejects({ approved_providers: many }, "egress_policy.approved_providers");
    const spaces = Object.fromEntries(Array.from({ length: MAX_POLICY_WORKSPACES + 1 }, (_, i) => [`w${i}`, {}]));
    rejects({ workspaces: spaces }, "egress_policy.workspaces");
  });

  it("알려진 제공자 목록이 없으면 이름 형식만 본다", () => {
    assert.deepEqual(validateEgressPolicy({ approved_providers: ["custom-x"] }), { approved_providers: ["custom-x"] });
    assert.throws(() => validateEgressPolicy({ approved_providers: [""] }), EgressPolicyValidationError);
  });
});

describe("resolveEgressRule", () => {
  it("정책이 없으면 기존 단계는 구성된 제공자를, 새 단계는 로컬만 쓴다", () => {
    for (const stage of EXTERNAL_DEFAULT_STAGES) {
      assert.deepEqual(resolveEgressRule(null, null, stage), { localOnly: false, approvedProviders: null }, stage);
    }
    assert.deepEqual(resolveEgressRule(null, null, "unlabeled"), { localOnly: true, approvedProviders: null });
    assert.deepEqual(resolveEgressRule(undefined, "w", "synthesis"), { localOnly: true, approvedProviders: null });
  });

  it("키 값이 단계 기본값을 덮고 workspace 값이 키 값을 덮는다", () => {
    const policy = {
      local_only        : true,
      approved_providers: ["anthropic"],
      workspaces        : { open: { local_only: false }, wide: { approved_providers: null } }
    };
    assert.deepEqual(resolveEgressRule(policy, null, "split"),   { localOnly: true,  approvedProviders: ["anthropic"] });
    assert.deepEqual(resolveEgressRule(policy, "other", "split"), { localOnly: true,  approvedProviders: ["anthropic"] });
    assert.deepEqual(resolveEgressRule(policy, "open", "split"),  { localOnly: false, approvedProviders: ["anthropic"] });
    assert.deepEqual(resolveEgressRule(policy, "wide", "split"),  { localOnly: true,  approvedProviders: null });
  });

  it("키나 workspace의 명시 허용은 새 단계도 연다", () => {
    assert.deepEqual(resolveEgressRule({ local_only: false }, null, "synthesis"), { localOnly: false, approvedProviders: null });
    assert.deepEqual(
      resolveEgressRule({ workspaces: { w: { local_only: false } } }, "w", "synthesis"),
      { localOnly: false, approvedProviders: null }
    );
  });
});

describe("단계 등록부", () => {
  it("구성된 제공자를 쓰는 기본 단계는 기존 LLM 기능 여섯 개뿐이다", () => {
    assert.deepEqual([...EXTERNAL_DEFAULT_STAGES].sort(),
      ["auto_reflect", "contradiction", "evaluate", "morpheme", "split", "synthetic_query"]);
  });

  it("알려진 단계 중 여섯 개 밖의 단계는 모두 local_only 기본값이다", () => {
    for (const [stage, def] of Object.entries(KNOWN_STAGES)) {
      const expected = EXTERNAL_DEFAULT_STAGES.includes(stage) ? STAGE_DEFAULT.CONFIGURED : STAGE_DEFAULT.LOCAL_ONLY;
      assert.equal(def, expected, stage);
    }
    for (const stage of EXTERNAL_DEFAULT_STAGES) assert.equal(KNOWN_STAGES[stage], STAGE_DEFAULT.CONFIGURED, stage);
  });

  it("여섯 단계만 정책 없이 외부 제공자를 쓰고 그 밖의 이름은 로컬만 쓴다", () => {
    for (const stage of EXTERNAL_DEFAULT_STAGES) assert.equal(stageDefaultLocalOnly(stage), false, stage);
    for (const stage of ["synthesis", "unlabeled", "", "toString", "__proto__"]) assert.equal(stageDefaultLocalOnly(stage), true, stage);
  });
});

describe("decideEgress 판정 표", () => {
  const rows = [
    /* enabled, class,      localOnly, approved,       name,        allow, reason */
    [false, "external", true,  ["x"],          "anthropic", true,  "switch_off"],
    [true,  "local",    true,  ["x"],          "ollama",    true,  "local"],
    [true,  "local",    false, [],             "ollama",    true,  "local"],
    [true,  "external", true,  null,           "anthropic", false, "local_only"],
    [true,  "external", true,  ["anthropic"],  "anthropic", false, "local_only"],
    [true,  "external", false, null,           "anthropic", true,  "configured"],
    [true,  "external", false, ["anthropic"],  "anthropic", true,  "approved"],
    [true,  "external", false, ["openai"],     "anthropic", false, "not_approved"],
    [true,  "external", false, [],             "anthropic", false, "not_approved"]
  ];
  for (const [enabled, providerClass, localOnly, approvedProviders, providerName, allow, reason] of rows) {
    it(`${enabled ? "on" : "off"} ${providerClass} localOnly=${localOnly} approved=${JSON.stringify(approvedProviders)} -> ${reason}`, () => {
      assert.deepEqual(
        decideEgress({ enabled, providerClass, providerName, rule: { localOnly, approvedProviders } }),
        { allow, reason }
      );
    });
  }
});

describe("evaluateEgress", () => {
  const policy = { workspaces: { closed: { local_only: true } } };

  it("여러 workspace 중 하나라도 막으면 막는다", () => {
    const base = { enabled: true, policy, stage: "contradiction", providerName: "anthropic", providerClass: "external" };
    assert.equal(evaluateEgress({ ...base, workspaces: ["a", "b"] }).allow, true);
    assert.deepEqual(evaluateEgress({ ...base, workspaces: ["a", "closed"] }), { allow: false, reason: "local_only" });
  });

  it("workspace가 없으면 키 단위로 판정한다", () => {
    const base = { enabled: true, policy: { local_only: true }, stage: "split", providerName: "anthropic", providerClass: "external" };
    assert.equal(evaluateEgress({ ...base, workspaces: [] }).allow, false);
    assert.equal(evaluateEgress({ ...base, workspaces: [null, undefined] }).allow, false);
    assert.equal(evaluateEgress({ ...base, providerClass: "local", providerName: "ollama" }).allow, true);
  });
});

describe("stageLabel과 오류", () => {
  it("등록되지 않은 단계는 other로 묶는다", () => {
    assert.equal(stageLabel("split"), "split");
    assert.equal(stageLabel("whatever"), "other");
    assert.equal(stageLabel(undefined), "other");
  });

  it("EgressSkippedError는 단계와 사유를 싣는다", () => {
    const err = new EgressSkippedError("split", "local_only");
    assert.equal(err.name, "EgressSkippedError");
    assert.equal(err.code, "LLM_EGRESS_SKIPPED");
    assert.equal(err.stage, "split");
    assert.equal(err.reason, "local_only");
  });
});
