/**
 * OpenAPI 스펙의 상태 확인 경로 시험.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */
import { describe, it } from "node:test";
import assert           from "node:assert/strict";
import { buildSpec }    from "../../lib/openapi.js";

const REASONS = ["db_timeout", "db_error"];

describe("OpenAPI 상태 확인 경로", () => {
  for (const [isMaster, permissions] of [[false, ["read"]], [true, null]]) {
    it(`GET /health/live와 /health/ready를 인증 없이 광고한다 (master=${isMaster})`, () => {
      const spec = buildSpec(isMaster, permissions);
      for (const route of ["/health/live", "/health/ready"]) {
        assert.ok(spec.paths[route]?.get, `${route} 없음`);
        assert.deepEqual(spec.paths[route].get.security, []);
      }
    });
  }

  it("live는 200만, ready는 200과 503을 정의한다", () => {
    const spec = buildSpec(false, ["read"]);
    assert.deepEqual(Object.keys(spec.paths["/health/live"].get.responses), ["200"]);
    assert.deepEqual(Object.keys(spec.paths["/health/ready"].get.responses), ["200", "503"]);
  });

  it("ready 503의 reason은 고정 어휘다", () => {
    const spec   = buildSpec(false, ["read"]);
    const schema = spec.paths["/health/ready"].get.responses[503].content["application/json"].schema;
    assert.deepEqual(schema.properties.reason.enum, REASONS);
    assert.deepEqual(schema.properties.status.enum, ["not_ready"]);
  });

  it("operationId가 경로 전체에서 유일하다", () => {
    const ids = Object.values(buildSpec(true, null).paths).flatMap(p => Object.values(p).map(op => op?.operationId)).filter(Boolean);
    assert.equal(new Set(ids).size, ids.length);
  });
});
