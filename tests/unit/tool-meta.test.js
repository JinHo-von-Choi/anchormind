/**
 * tool-registry.js 메타 필드 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-04-18
 *
 * 검증 대상:
 *   - 전체 도구가 meta 필드를 보유하는지
 *   - enum 값(capabilities / riskLevel)이 허용 범위 내인지
 *   - destructive 도구는 idempotent=false인지
 *   - requiresMaster=true 도구는 admin 또는 memory:destructive capability를 가지는지
 */

import { describe, it } from "node:test";
import assert            from "node:assert/strict";
import { TOOL_REGISTRY } from "../../lib/tool-registry.js";

const VALID_CAPABILITIES = new Set(["memory:read", "memory:write", "memory:destructive", "analytics:read", "admin", "session:write"]);
const VALID_RISK_LEVELS  = new Set(["safe", "caution", "destructive"]);

describe("TOOL_REGISTRY — meta 필드 존재 검증", () => {

  it("모든 도구가 meta 객체를 가진다", () => {
    for (const [name, entry] of TOOL_REGISTRY) {
      assert.ok(entry.meta !== undefined && entry.meta !== null,
        `도구 "${name}": meta 필드 없음`);
      assert.strictEqual(typeof entry.meta, "object",
        `도구 "${name}": meta 타입이 object가 아님`);
    }
  });

  it("모든 도구의 meta에 5개 필드가 모두 존재한다", () => {
    const REQUIRED = ["capabilities", "riskLevel", "requiresMaster", "beta", "idempotent"];
    for (const [name, entry] of TOOL_REGISTRY) {
      for (const field of REQUIRED) {
        assert.ok(Object.prototype.hasOwnProperty.call(entry.meta, field),
          `도구 "${name}": meta.${field} 누락`);
      }
    }
  });

});

describe("TOOL_REGISTRY — meta enum 값 유효성", () => {

  it("모든 도구의 capabilities는 비어 있지 않은 배열이다", () => {
    for (const [name, entry] of TOOL_REGISTRY) {
      assert.ok(Array.isArray(entry.meta.capabilities) && entry.meta.capabilities.length > 0,
        `도구 "${name}": capabilities가 비어있거나 배열이 아님`);
    }
  });

  it("모든 도구의 capabilities 값은 허용된 enum 내에 있다", () => {
    for (const [name, entry] of TOOL_REGISTRY) {
      for (const cap of entry.meta.capabilities) {
        assert.ok(VALID_CAPABILITIES.has(cap),
          `도구 "${name}": 허용되지 않은 capability "${cap}"`);
      }
    }
  });

  it("모든 도구의 riskLevel은 허용된 enum 내에 있다", () => {
    for (const [name, entry] of TOOL_REGISTRY) {
      assert.ok(VALID_RISK_LEVELS.has(entry.meta.riskLevel),
        `도구 "${name}": 허용되지 않은 riskLevel "${entry.meta.riskLevel}"`);
    }
  });

  it("모든 도구의 requiresMaster / beta / idempotent는 boolean이다", () => {
    for (const [name, entry] of TOOL_REGISTRY) {
      assert.strictEqual(typeof entry.meta.requiresMaster, "boolean",
        `도구 "${name}": meta.requiresMaster가 boolean이 아님`);
      assert.strictEqual(typeof entry.meta.beta, "boolean",
        `도구 "${name}": meta.beta가 boolean이 아님`);
      assert.strictEqual(typeof entry.meta.idempotent, "boolean",
        `도구 "${name}": meta.idempotent가 boolean이 아님`);
    }
  });

});

describe("TOOL_REGISTRY — destructive 도구 불변 규칙", () => {

  it("riskLevel=destructive 도구는 idempotent=false다", () => {
    for (const [name, entry] of TOOL_REGISTRY) {
      if (entry.meta.riskLevel === "destructive") {
        assert.strictEqual(entry.meta.idempotent, false,
          `도구 "${name}": destructive이지만 idempotent=true`);
      }
    }
  });

  it("forget 도구는 riskLevel=destructive, idempotent=false다", () => {
    const entry = TOOL_REGISTRY.get("forget");
    assert.ok(entry, "forget 도구가 레지스트리에 없음");
    assert.strictEqual(entry.meta.riskLevel, "destructive");
    assert.strictEqual(entry.meta.idempotent, false);
  });

  it("memory_consolidate 도구는 riskLevel=destructive, idempotent=false, requiresMaster=true다", () => {
    const entry = TOOL_REGISTRY.get("memory_consolidate");
    assert.ok(entry, "memory_consolidate 도구가 레지스트리에 없음");
    assert.strictEqual(entry.meta.riskLevel, "destructive");
    assert.strictEqual(entry.meta.idempotent, false);
    assert.strictEqual(entry.meta.requiresMaster, true);
  });

});

describe("TOOL_REGISTRY — requiresMaster 제약 규칙", () => {

  it("requiresMaster=true 도구는 admin 또는 memory:destructive capability를 가진다", () => {
    for (const [name, entry] of TOOL_REGISTRY) {
      if (entry.meta.requiresMaster) {
        const caps = entry.meta.capabilities;
        const hasAdminOrDestructive = caps.includes("admin") || caps.includes("memory:destructive");
        assert.ok(hasAdminOrDestructive,
          `도구 "${name}": requiresMaster=true이지만 admin/memory:destructive capability 없음`);
      }
    }
  });

  it("apply_update는 requiresMaster=true, admin capability를 가진다", () => {
    const entry = TOOL_REGISTRY.get("apply_update");
    assert.ok(entry, "apply_update 도구가 레지스트리에 없음");
    assert.strictEqual(entry.meta.requiresMaster, true);
    assert.ok(entry.meta.capabilities.includes("admin"));
  });

  it("check_update도 master에게만 노출된다", () => {
    const entry = TOOL_REGISTRY.get("check_update");
    assert.strictEqual(entry.meta.requiresMaster, true);
    assert.ok(entry.meta.capabilities.includes("admin"));
  });

  it("memory_stats는 전역 집계이므로 requiresMaster=true다", () => {
    const entry = TOOL_REGISTRY.get("memory_stats");
    assert.strictEqual(entry.meta.requiresMaster, true);
    assert.ok(entry.meta.capabilities.includes("admin"));
  });

});

describe("TOOL_REGISTRY — audit log input safety", () => {
  it("session_rotate 로그에 사용자 reason을 포함하지 않는다", () => {
    const message = TOOL_REGISTRY.get("session_rotate").log({ reason: "synthetic\nforged" });
    assert.equal(message, "Session rotated");
    assert.doesNotMatch(message, /forged|\n/);
  });
});

describe("TOOL_REGISTRY — 읽기 도구 안전성 규칙", () => {

  const READ_ONLY_TOOLS = ["recall", "context", "graph_explore", "fragment_history",
    "search_traces", "reconstruct_history", "memory_stats", "get_skill_guide"];

  it("읽기 전용 도구는 riskLevel=safe, idempotent=true다", () => {
    for (const name of READ_ONLY_TOOLS) {
      const entry = TOOL_REGISTRY.get(name);
      assert.ok(entry, `도구 "${name}"가 레지스트리에 없음`);
      assert.strictEqual(entry.meta.riskLevel, "safe",
        `도구 "${name}": 읽기 도구이지만 riskLevel="${entry.meta.riskLevel}"`);
      assert.strictEqual(entry.meta.idempotent, true,
        `도구 "${name}": 읽기 도구이지만 idempotent=false`);
    }
  });

});
