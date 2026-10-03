/**
 * 벤치마크 CLI의 대상 DB 표시와 기준선 저장 조건 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */

import { describe, it, mock, after } from "node:test";
import assert                        from "node:assert/strict";

const realConfig = await import("../../lib/config.js");
mock.module("../../lib/config.js", {
  namedExports: {
    ...realConfig,
    DB_HOST    : "db-host.example",
    DB_PORT    : 5432,
    DB_NAME    : "bench_target",
    DB_USER    : "bench_user",
    DB_PASSWORD: "pw-should-not-appear-123"
  }
});

const { dbTargetLine, baselineRefusal }              = await import("../../lib/cli/benchmark.js");
const { teardownTestResources, assertCleanShutdown } = await import("../_lifecycle.js");

after(async () => {
  await teardownTestResources();
  await assertCleanShutdown();
});

describe("dbTargetLine", () => {
  it("접속 설정의 호스트와 데이터베이스 이름을 담는다", () => {
    const line = dbTargetLine();
    assert.match(line, /db-host\.example/);
    assert.match(line, /bench_target/);
  });

  it("사용자와 비밀번호는 담지 않는다", () => {
    const line = dbTargetLine();
    assert.doesNotMatch(line, /pw-should-not-appear-123/);
    assert.doesNotMatch(line, /bench_user/);
  });
});

describe("baselineRefusal", () => {
  it("임베딩된 파편이 0건이면 안내 문구를 돌려준다", () => {
    const msg = baselineRefusal({ embedding: { embedded: 0, pending: 0 } });
    assert.match(msg, /--save-baseline/);
  });

  it("임베딩된 파편이 있으면 null", () => {
    assert.equal(baselineRefusal({ embedding: { embedded: 100, pending: 0 } }), null);
  });

  it("적재를 건너뛴 실행은 --no-seed 실행이 기준선이 될 수 없다고 밝힌다", () => {
    const msg = baselineRefusal({ embedding: { embedded: 0, pending: 0 } }, { seed: false });
    assert.match(msg, /--no-seed 실행은 파편을 적재하지도 임베딩하지도 않으므로 --save-baseline으로 저장할 수 없다/);
  });

  it("적재했지만 임베딩이 0건인 실행의 사유에는 --no-seed 안내를 붙이지 않는다", () => {
    const msg = baselineRefusal({ embedding: { embedded: 0, pending: 0 } }, { seed: true });
    assert.match(msg, /임베딩된 파편이 0건/);
    assert.doesNotMatch(msg, /--no-seed/);
    assert.doesNotMatch(baselineRefusal({ embedding: { embedded: 0, pending: 0 } }), /--no-seed/);
  });

  it("임베딩된 파편이 있으면 적재 여부와 관계없이 null", () => {
    assert.equal(baselineRefusal({ embedding: { embedded: 3, pending: 0 } }, { seed: false }), null);
  });

  it("임베딩 집계가 없으면 거부한다", () => {
    assert.match(baselineRefusal({}), /--save-baseline/);
  });
});
