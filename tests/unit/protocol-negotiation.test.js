/**
 * 프로토콜 버전 협상과 협상 지표 라벨 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */
import { describe, it } from "node:test";
import assert           from "node:assert/strict";

import { negotiateProtocolVersion, isProtocolDateString } from "../../lib/jsonrpc.js";
import { SUPPORTED_PROTOCOL_VERSIONS }                    from "../../lib/config.js";
import {
  register,
  protocolVersionLabel,
  recordProtocolNegotiation,
  recordProtocolVersionReanchored
} from "../../lib/metrics.js";

const OLDEST = SUPPORTED_PROTOCOL_VERSIONS[SUPPORTED_PROTOCOL_VERSIONS.length - 1];
const LATEST = SUPPORTED_PROTOCOL_VERSIONS[0];

describe("isProtocolDateString", () => {
  it("YYYY-MM-DD 형식의 실재 날짜만 참이다", () => {
    assert.equal(isProtocolDateString("2025-03-26"), true);
    for (const v of ["1", "99", "x-1999", "2025-3-26", " 2025-03-26", "2025-02-30", "2025-13-01", "2025-03-26T00:00:00Z", 1, null, {}]) {
      assert.equal(isProtocolDateString(v), false, JSON.stringify(v));
    }
  });
});

describe("negotiateProtocolVersion", () => {
  it("지원 목록의 값은 그대로 돌려준다", () => {
    for (const v of SUPPORTED_PROTOCOL_VERSIONS) assert.equal(negotiateProtocolVersion(v), v);
  });

  it("값이 없으면 기본 버전이다", () => {
    for (const v of [undefined, null, ""]) assert.equal(negotiateProtocolVersion(v), LATEST);
  });

  it("형식이 아닌 값은 가장 오래된 지원 버전이다", () => {
    for (const v of ["1", "2", "99", "x-1999", "abc", "2025-02-30", 1, { a: 1 }]) {
      assert.equal(negotiateProtocolVersion(v), OLDEST, JSON.stringify(v));
    }
  });

  it("지원 목록 사이의 날짜는 그 이하의 가장 새 지원 버전이다", () => {
    assert.equal(negotiateProtocolVersion("2025-07-01"), "2025-06-18");
    assert.equal(negotiateProtocolVersion("2025-01-01"), "2024-11-05");
  });

  it("최신보다 새 날짜는 최신 지원 버전이다", () => {
    assert.equal(negotiateProtocolVersion("2026-05-01"), LATEST);
  });

  it("모든 결과는 지원 목록 안에 있다", () => {
    for (const v of ["1", "x-1999", "2025-01-01", "2030-12-31", "1999-01-01", 7, [], "2025-11-25"]) {
      assert.ok(SUPPORTED_PROTOCOL_VERSIONS.includes(negotiateProtocolVersion(v)), JSON.stringify(v));
    }
  });
});

describe("프로토콜 버전 지표 라벨", () => {
  it("protocolVersionLabel은 지원 버전, none, other만 낸다", () => {
    assert.equal(protocolVersionLabel("2025-06-18"), "2025-06-18");
    assert.equal(protocolVersionLabel(undefined), "none");
    assert.equal(protocolVersionLabel(""), "none");
    assert.equal(protocolVersionLabel("x-1999"), "other");
    assert.equal(protocolVersionLabel(1), "other");
    assert.equal(protocolVersionLabel({ a: 1 }), "other");
  });

  it("임의 요청 값이 들어와도 협상 지표의 라벨 값은 닫힌 집합이다", async () => {
    const allowed = new Set([...SUPPORTED_PROTOCOL_VERSIONS, "none", "other"]);
    for (const v of ["1", "x-1999", "99", "2025-01-01", "abc", 1, { a: 1 }, undefined]) {
      recordProtocolNegotiation(v, negotiateProtocolVersion(v));
    }
    const metric = await register.getSingleMetric("mcp_protocol_version_negotiations_total").get();
    for (const { labels } of metric.values) {
      assert.ok(allowed.has(labels.requested_version), labels.requested_version);
      assert.ok(allowed.has(labels.negotiated_version), labels.negotiated_version);
    }
  });

  it("재앵커링 지표의 from 라벨은 지원 버전, null, other만 낸다", async () => {
    recordProtocolVersionReanchored("x-1999", "2025-03-26");
    recordProtocolVersionReanchored(null, "2025-06-18");
    const allowed = new Set([...SUPPORTED_PROTOCOL_VERSIONS, "null", "other", "none"]);
    const metric  = await register.getSingleMetric("mcp_protocol_version_reanchored_total").get();
    for (const { labels } of metric.values) {
      assert.ok(allowed.has(labels.from), labels.from);
      assert.ok(allowed.has(labels.to), labels.to);
    }
  });
});
