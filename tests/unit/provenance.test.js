/**
 * 파편 출처와 신뢰 등급 판정 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * lib/memory/provenance.js의 순수 함수를 확인한다. 등급 판정(주장 출처의 등급과 키 상한의 작은 값),
 * 주입 제외 술어(NULL은 2), 관측 클라이언트 표기, 서버 주입 문맥 해석을 본다.
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";

import {
  ORIGINS,
  ORIGIN_TIERS,
  TRUST_TIER,
  DEFAULT_TRUST_TIER,
  MIN_INJECTABLE_TIER,
  CLAIM_ENTRIES,
  isOrigin,
  originLabel,
  claimedOrigin,
  originTier,
  keyTrustCap,
  resolveTrustTier,
  effectiveTrustTier,
  isInjectable,
  injectableTierSql,
  sanitizeClientName,
  clientNameFromInitialize,
  observedClient,
  provenanceContext,
  provenanceStamp,
  hasProvenance,
  provenanceInsertParts
} from "../../lib/memory/provenance.js";
import { TRUSTED_ORIGIN_PERMISSION, trustedOriginGranted } from "../../lib/rbac.js";

describe("출처 값", () => {
  it("허용 출처는 여섯 가지다", () => {
    assert.deepEqual([...ORIGINS].sort(), [
      "agent_inferred", "consolidation", "external_content", "import", "tool_output", "user_stated"
    ]);
    for (const origin of ORIGINS) assert.equal(isOrigin(origin), true, origin);
  });

  it("출처마다 등급이 있고 등급은 0~3 정수다", () => {
    for (const origin of ORIGINS) {
      const tier = ORIGIN_TIERS[origin];
      assert.ok(Number.isInteger(tier) && tier >= TRUST_TIER.QUARANTINED && tier <= TRUST_TIER.HIGH, origin);
    }
    assert.equal(ORIGIN_TIERS.user_stated, TRUST_TIER.HIGH);
    assert.equal(ORIGIN_TIERS.external_content, TRUST_TIER.LOW);
  });

  it("허용 밖의 값은 출처가 아니다", () => {
    for (const value of [null, undefined, "", "USER_STATED", "admin", 3, {}, "user_stated "]) {
      assert.equal(isOrigin(value), false, String(value));
      assert.equal(originLabel(value), null, String(value));
    }
    assert.equal(originLabel("tool_output"), "tool_output");
  });
});

describe("claimedOrigin", () => {
  it("remember와 batch_remember만 클라이언트 주장을 받는다", () => {
    assert.deepEqual([...CLAIM_ENTRIES].sort(), ["batch_remember", "remember"]);
    assert.equal(claimedOrigin("remember", "user_stated"), "user_stated");
    assert.equal(claimedOrigin("batch_remember", "external_content"), "external_content");
    assert.equal(claimedOrigin("amend", "user_stated"), null);
    assert.equal(claimedOrigin("reflect", "user_stated"), null);
  });

  it("서버 진입점은 정해진 출처를 쓰고 주장을 무시한다", () => {
    assert.equal(claimedOrigin("admin_import", "user_stated"), "import");
    assert.equal(claimedOrigin("cli_import", null), "import");
    assert.equal(claimedOrigin("consolidate_split", "user_stated"), "consolidation");
    assert.equal(claimedOrigin("auto_reflect", undefined), "consolidation");
  });

  it("주장이 없으면 null이다", () => {
    assert.equal(claimedOrigin("remember", undefined), null);
    assert.equal(claimedOrigin("remember", null), null);
  });
});

describe("키 상한", () => {
  it("trusted_origin 권한 또는 마스터 키만 높음(3)까지 허용한다", () => {
    assert.equal(TRUSTED_ORIGIN_PERMISSION, "trusted_origin");
    assert.equal(keyTrustCap({ isMaster: true, permissions: null }), TRUST_TIER.HIGH);
    assert.equal(keyTrustCap({ isMaster: false, permissions: ["read", "write", "trusted_origin"] }), TRUST_TIER.HIGH);
    assert.equal(keyTrustCap({ isMaster: false, permissions: ["read", "write"] }), TRUST_TIER.NORMAL);
    assert.equal(keyTrustCap({ isMaster: false, permissions: null }), TRUST_TIER.NORMAL);
    assert.equal(keyTrustCap({}), TRUST_TIER.NORMAL);
  });

  it("trustedOriginGranted는 문자열이 정확히 같을 때만 참이다", () => {
    assert.equal(trustedOriginGranted(["Trusted_Origin"], false), false);
    assert.equal(trustedOriginGranted("trusted_origin", false), false);
    assert.equal(trustedOriginGranted([], true), true);
  });
});

describe("등급 판정", () => {
  it("주장 출처의 등급과 키 상한 중 작은 값이다", () => {
    assert.equal(resolveTrustTier("user_stated", TRUST_TIER.HIGH), 3);
    assert.equal(resolveTrustTier("user_stated", TRUST_TIER.NORMAL), 2);
    assert.equal(resolveTrustTier("external_content", TRUST_TIER.HIGH), 1);
    assert.equal(resolveTrustTier("tool_output", TRUST_TIER.NORMAL), 2);
    assert.equal(resolveTrustTier("agent_inferred", TRUST_TIER.LOW), 1);
  });

  it("주장이 없으면 기본 등급(2)에 상한을 건다", () => {
    assert.equal(originTier(null), DEFAULT_TRUST_TIER);
    assert.equal(resolveTrustTier(null, TRUST_TIER.HIGH), 2);
    assert.equal(resolveTrustTier(null, TRUST_TIER.NORMAL), 2);
  });

  it("상한이 잘못된 값이면 기본 상한(2)이다", () => {
    for (const cap of [undefined, null, 7, -1, 2.5, "3"]) {
      assert.equal(resolveTrustTier("user_stated", cap), 2, String(cap));
    }
  });

  it("verified 주장은 등급을 올리지 않는다", () => {
    const base = { entry: "remember", claim: "agent_inferred", clientName: "c", trustCap: TRUST_TIER.HIGH };
    const observed = provenanceStamp({ ...base, assertionStatus: "observed" });
    const verified = provenanceStamp({ ...base, assertionStatus: "verified" });
    assert.equal(verified.trust_tier, observed.trust_tier);
    assert.equal(verified.trust_tier, 2);
  });
});

describe("주입 제외 술어", () => {
  it("NULL과 미지정은 2로 보고 주입 대상이다", () => {
    assert.equal(effectiveTrustTier(null), 2);
    assert.equal(effectiveTrustTier(undefined), 2);
    assert.equal(isInjectable({}), true);
    assert.equal(isInjectable({ trust_tier: null }), true);
    assert.equal(isInjectable(null), true);
  });

  it("1 이하는 제외하고 2 이상은 포함한다", () => {
    assert.equal(MIN_INJECTABLE_TIER, 2);
    assert.equal(isInjectable({ trust_tier: 0 }), false);
    assert.equal(isInjectable({ trust_tier: 1 }), false);
    assert.equal(isInjectable({ trust_tier: 2 }), true);
    assert.equal(isInjectable({ trust_tier: 3 }), true);
  });

  it("범위 밖의 저장값은 2로 본다", () => {
    for (const value of [9, -3, 1.5, "x"]) assert.equal(effectiveTrustTier(value), 2, String(value));
    assert.equal(effectiveTrustTier("1"), 1);
  });

  it("SQL 술어는 NULL을 포함하고 같은 문턱을 쓴다", () => {
    assert.equal(injectableTierSql("trust_tier"), "(trust_tier IS NULL OR trust_tier >= 2)");
    assert.equal(injectableTierSql("f.trust_tier"), "(f.trust_tier IS NULL OR f.trust_tier >= 2)");
    assert.throws(() => injectableTierSql("trust_tier; DROP"), TypeError);
  });

  it("SQL 술어와 순수 술어는 0~3과 NULL에서 같은 판정을 낸다", () => {
    const sqlLike = tier => tier === null || tier >= MIN_INJECTABLE_TIER;
    for (const tier of [null, 0, 1, 2, 3]) {
      assert.equal(isInjectable({ trust_tier: tier }), sqlLike(tier), String(tier));
    }
  });
});

describe("관측 클라이언트", () => {
  it("clientInfo.name을 허용 문자로 줄이고 길이를 제한한다", () => {
    assert.equal(sanitizeClientName("claude-code"), "claude-code");
    assert.equal(sanitizeClientName("  Claude Desktop "), "Claude Desktop");
    assert.equal(sanitizeClientName("a/b\n<c>"), "a_b_c_");
    assert.equal(sanitizeClientName("x".repeat(200)).length, 64);
    for (const value of [null, undefined, "", "   ", 42, {}]) assert.equal(sanitizeClientName(value), null, String(value));
  });

  it("initialize 요청에서만 이름을 읽는다", () => {
    assert.equal(clientNameFromInitialize({ method: "initialize", params: { clientInfo: { name: "cursor" } } }), "cursor");
    assert.equal(clientNameFromInitialize({ method: "tools/call", params: { clientInfo: { name: "cursor" } } }), null);
    assert.equal(clientNameFromInitialize({ method: "initialize", params: {} }), null);
    assert.equal(clientNameFromInitialize(null), null);
  });

  it("클라이언트 이름과 진입점 이름을 묶는다", () => {
    assert.equal(observedClient("remember", "claude-code"), "claude-code/remember");
    assert.equal(observedClient("batch_remember", null), "unknown/batch_remember");
    assert.equal(observedClient("admin_import", null), "internal/admin_import");
    assert.equal(observedClient("consolidate_split", undefined), "internal/consolidate_split");
    assert.equal(observedClient("cli_remember", null), "internal/cli_remember");
  });
});

describe("서버 주입 문맥", () => {
  it("세션 문맥에서 클라이언트 이름과 키 상한을 만든다", () => {
    assert.deepEqual(
      provenanceContext({ _clientName: "cursor", _isMaster: false, _permissions: ["read", "write"] }),
      { clientName: "cursor", trustCap: 2 }
    );
    assert.deepEqual(provenanceContext({ _isMaster: true, _permissions: null }), { clientName: null, trustCap: 3 });
    assert.deepEqual(provenanceContext({}), { clientName: null, trustCap: 2 });
    assert.deepEqual(provenanceContext(null), { clientName: null, trustCap: 2 });
  });

  it("서버가 넘긴 _provenance가 있으면 그 값을 정규화해 쓴다", () => {
    assert.deepEqual(
      provenanceContext({ _provenance: { clientName: "c\u0000", trustCap: 3 }, _isMaster: false }),
      { clientName: "c_", trustCap: 3 }
    );
    assert.deepEqual(provenanceContext({ _provenance: { trustCap: 9 } }), { clientName: null, trustCap: 2 });
  });
});

describe("provenanceStamp", () => {
  it("출처, 관측 클라이언트, 등급 세 값을 만든다", () => {
    assert.deepEqual(
      provenanceStamp({ entry: "remember", claim: "user_stated", clientName: "claude-code", trustCap: 3 }),
      { origin: "user_stated", observed_client: "claude-code/remember", trust_tier: 3 }
    );
    assert.deepEqual(
      provenanceStamp({ entry: "remember", claim: "user_stated", clientName: "claude-code", trustCap: 2 }),
      { origin: "user_stated", observed_client: "claude-code/remember", trust_tier: 2 }
    );
    assert.deepEqual(
      provenanceStamp({ entry: "admin_import", claim: "user_stated" }),
      { origin: "import", observed_client: "internal/admin_import", trust_tier: 2 }
    );
  });
});

describe("INSERT 조각", () => {
  it("출처 값이 없는 파편은 열을 덧붙이지 않는다", () => {
    assert.equal(hasProvenance({ id: "a" }), false);
    assert.deepEqual(provenanceInsertParts({ id: "a" }, 33), { columns: "", placeholders: "", values: [] });
  });

  it("출처 값이 있으면 세 열을 시작 번호부터 잇는다", () => {
    const fragment = { origin: "tool_output", observed_client: "c/remember", trust_tier: 2 };
    assert.equal(hasProvenance(fragment), true);
    assert.deepEqual(provenanceInsertParts(fragment, 33), {
      columns     : ", origin, observed_client, trust_tier",
      placeholders: ", $33, $34, $35::smallint",
      values      : ["tool_output", "c/remember", 2]
    });
  });

  it("force이면 출처 값이 없어도 NULL 세 개를 싣는다", () => {
    assert.deepEqual(provenanceInsertParts({}, 5, { force: true }).values, [null, null, null]);
  });
});
