/**
 * 인증 저장소 장애 응답 상태 결정 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */
import { describe, it } from "node:test";
import assert           from "node:assert/strict";
import fs               from "node:fs";
import path             from "node:path";

import { authStoreUnavailableStatus } from "../../lib/http/helpers.js";

describe("authStoreUnavailableStatus", () => {
  it("설정이 503이고 결과가 unavailable일 때만 503이다", () => {
    assert.equal(authStoreUnavailableStatus({ valid: false, unavailable: true }, 503), 503);
    assert.equal(authStoreUnavailableStatus({ valid: false, unavailable: true }, 401), null);
    assert.equal(authStoreUnavailableStatus({ valid: false }, 503), null);
    assert.equal(authStoreUnavailableStatus({ valid: true, unavailable: true }, 503), null);
  });

  it("initialize와 세션 자동 복구 실패 경로가 결정을 거친다", () => {
    const src = fs.readFileSync(path.resolve(import.meta.dirname, "../../lib/handlers/mcp-handler.js"), "utf8");
    assert.equal((src.match(/await _respondAuthStoreUnavailable\(/g) ?? []).length, 2);
  });
});
