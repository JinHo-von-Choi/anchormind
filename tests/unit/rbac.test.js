import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkPermission, TOOL_PERMISSIONS } from "../../lib/rbac.js";

describe("RBAC permission check", () => {
  it("allows when permission exists", () => {
    assert.ok(checkPermission(["read", "write"], "remember").allowed);
    assert.ok(checkPermission(["read", "write"], "recall").allowed);
  });

  it("denies when permission missing", () => {
    const r1 = checkPermission(["read"], "remember");
    assert.ok(!r1.allowed);
    assert.strictEqual(r1.required, "write");
  });

  it("allows everything for null permissions (master key)", () => {
    assert.ok(checkPermission(null, "memory_consolidate", true).allowed);
    assert.ok(checkPermission(null, "remember", true).allowed);
  });

  it("null permissions without explicit master is denied", () => {
    assert.equal(checkPermission(null, "recall", false).allowed, false);
  });

  it("admin permission implies write and read", () => {
    assert.ok(checkPermission(["admin"], "remember").allowed);
    assert.ok(checkPermission(["admin"], "recall").allowed);
  });

  it("denies non-admin for admin-only tools", () => {
    const r = checkPermission(["read", "write"], "memory_consolidate");
    assert.ok(!r.allowed);
    assert.strictEqual(r.required, "admin");
  });

  it("denies unknown tools (default-deny)", () => {
    const r = checkPermission(["read"], "unknown_tool");
    assert.ok(!r.allowed);
    assert.strictEqual(r.reason, "unknown_tool");
  });

  it("maps all memory tools", () => {
    assert.strictEqual(TOOL_PERMISSIONS["remember"], "write");
    assert.strictEqual(TOOL_PERMISSIONS["recall"], "read");
    assert.strictEqual(TOOL_PERMISSIONS["memory_consolidate"], "admin");
    assert.strictEqual(TOOL_PERMISSIONS["context"], "read");
  });
});
