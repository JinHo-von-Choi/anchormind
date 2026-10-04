import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ADMIN_ROUTES } from "../../lib/admin/admin-route-table.js";
import {
  ADMIN_HANDLER_MODULES,
  ADMIN_HANDLER_REGISTRY,
  DIRECT_ADMIN_ROUTE_MODULES,
  buildAdminHandlerRegistry
} from "../../lib/admin/admin-handler-registry.js";

const noop = async () => false;

describe("관리 핸들러 레지스트리", () => {
  it("라우트 표의 직접 처리 모듈을 뺀 집합과 정확히 같다", () => {
    const direct   = new Set(DIRECT_ADMIN_ROUTE_MODULES);
    const expected = [...new Set(ADMIN_ROUTES.map((route) => route.module))].filter((module) => !direct.has(module)).sort();
    assert.deepEqual(Object.keys(ADMIN_HANDLER_REGISTRY).sort(), expected);
  });

  it("감사 처리기는 일반 내보내기 처리기보다 먼저 실행된다", () => {
    assert.ok(ADMIN_HANDLER_MODULES.indexOf("admin-audit") < ADMIN_HANDLER_MODULES.indexOf("admin-export"));
  });

  it("중복 모듈을 거부한다", () => {
    assert.throws(
      () => buildAdminHandlerRegistry([
        { module: "a", handlers: [noop] },
        { module: "a", handlers: [noop] }
      ], ["a"], []),
      /duplicate admin handler module: a/
    );
  });

  it("누락 및 라우트 표 밖 모듈을 거부한다", () => {
    assert.throws(
      () => buildAdminHandlerRegistry([
        { module: "a", handlers: [noop] },
        { module: "extra", handlers: [noop] }
      ], ["a", "missing"], []),
      /missing=\[missing\] unexpected=\[extra\]/
    );
  });
});
