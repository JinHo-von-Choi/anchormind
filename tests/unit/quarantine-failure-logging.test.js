/**
 * 인접 링크 격리 실패 기록 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-05
 *
 * quarantineAdjacentLinks는 링크마다 Promise.allSettled로 격리를 시도한다.
 * 실패한 링크가 있으면 경고를 남기고, 반환값(allSettled 배열)은 그대로 돌려준다.
 */

import { describe, it, mock, beforeEach, after } from "node:test";
import assert                                    from "node:assert/strict";

const realDb     = await import("../../lib/tools/db.js");
const realLogger = await import("../../lib/logger.js");

const warn = mock.fn();
let linkRows = [];

mock.module("../../lib/logger.js", {
  exports: { ...realLogger, logWarn: warn }
});
mock.module("../../lib/tools/db.js", {
  exports: {
    ...realDb,
    getPrimaryPool: () => ({
      query  : async () => ({ rows: linkRows }),
      connect: async () => { throw new Error("pool exhausted"); }
    })
  }
});

const { quarantineAdjacentLinks }                    = await import("../../lib/memory/link/ReconsolidationEngine.js");
const { teardownTestResources, assertCleanShutdown } = await import("../_lifecycle.js");

const warnings = () => warn.mock.calls.map(c => String(c.arguments[0]));

beforeEach(() => {
  warn.mock.resetCalls();
  linkRows = [];
});

after(async () => {
  await teardownTestResources();
  await assertCleanShutdown();
});

describe("quarantineAdjacentLinks 실패 기록", () => {
  it("격리에 실패한 링크 수를 경고로 남기고 allSettled 결과는 그대로 돌려준다", async () => {
    linkRows = [{ id: "link-qf-1" }, { id: "link-qf-2" }];

    const settled = await quarantineAdjacentLinks("frag-a", "frag-b", null);

    assert.equal(settled.length, 2);
    assert.deepEqual(settled.map(r => r.status), ["rejected", "rejected"]);
    const lines = warnings().filter(l => l.includes("quarantine failed"));
    assert.equal(lines.length, 1, "링크마다가 아니라 한 번의 호출에 경고 한 건");
    assert.match(lines[0], /2\/2 links/);
    assert.match(lines[0], /frag-a<->frag-b/);
    assert.match(lines[0], /pool exhausted/);
  });

  it("대상 링크가 없으면 빈 배열을 돌려주고 경고하지 않는다", async () => {
    linkRows = [];
    assert.deepEqual(await quarantineAdjacentLinks("frag-c", "frag-d", null), []);
    assert.deepEqual(warnings(), []);
  });
});
