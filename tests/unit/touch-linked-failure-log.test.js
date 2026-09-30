/**
 * FragmentWriter.touchLinked 실패 기록 검사
 *
 * 작성자: 최진호
 * 작성일: 2026-09-30
 *
 * 갱신 질의가 실패하면 incrementAccess와 같은 형식의 경고를 남기고
 * 호출자에게 예외를 넘기지 않는지 DB 없이 확인한다.
 */

import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

let warnings = [];
let calls    = 0;

mock.module("../../lib/tools/db.js", {
  namedExports: {
    getPrimaryPool      : () => ({ query: async () => ({ rows: [] }) }),
    queryWithAgentVector: async () => {
      calls++;
      throw new Error("connection reset");
    }
  }
});
mock.module("../../lib/tools/embedding.js", {
  namedExports: { vectorToSql: value => JSON.stringify(value), computeContentHash: value => value }
});
mock.module("../../lib/logger.js", {
  namedExports: {
    logInfo : () => {},
    logDebug: () => {},
    logError: () => {},
    logWarn : message => warnings.push(message)
  }
});

const { FragmentWriter } = await import("../../lib/memory/write/FragmentWriter.js");

beforeEach(() => {
  warnings = [];
  calls    = 0;
});

describe("FragmentWriter.touchLinked 실패 처리", () => {
  it("질의 실패를 경고로 남기고 예외를 넘기지 않는다", async () => {
    const writer = new FragmentWriter();

    await assert.doesNotReject(writer.touchLinked(["a", "b"], "agent-a", "key-a"));

    assert.equal(calls, 1);
    assert.deepEqual(warnings, ["[FragmentWriter] touchLinked failed: connection reset"]);
  });

  it("incrementAccess 실패 경고와 같은 형식을 쓴다", async () => {
    const writer = new FragmentWriter();

    await writer.incrementAccess(["a"], "agent-a");
    await writer.touchLinked(["a"], "agent-a");

    assert.deepEqual(warnings, [
      "[FragmentWriter] incrementAccess failed: connection reset",
      "[FragmentWriter] touchLinked failed: connection reset"
    ]);
  });

  it("빈 입력은 질의도 경고도 발행하지 않는다", async () => {
    const writer = new FragmentWriter();

    await writer.touchLinked([], "agent-a");

    assert.equal(calls, 0);
    assert.deepEqual(warnings, []);
  });
});
