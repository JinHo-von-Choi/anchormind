import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildSpec } from "../../lib/openapi.js";

function advertisedNames(spec) {
  return spec.paths["/mcp"].post["x-mcp-tools"].map(tool => tool.name);
}

describe("OpenAPI master-only tool advertisement", () => {
  it("일반 API key에는 requiresMaster 도구를 광고하지 않는다", () => {
    const names = advertisedNames(buildSpec(false, ["read", "admin"]));
    for (const name of ["memory_stats", "memory_consolidate", "check_update", "apply_update"]) {
      assert.equal(names.includes(name), false);
    }
  });

  it("명시적 master에는 master 도구를 광고한다", () => {
    const names = advertisedNames(buildSpec(true, null));
    for (const name of ["memory_stats", "memory_consolidate", "check_update", "apply_update"]) {
      assert.equal(names.includes(name), true);
    }
  });
});
