/**
 * ConflictResolver 조용한 실패 기록 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-05
 *
 * 자동 링크 조회 실패와 인접 링크 격리 실패가 경고로 남는지 확인한다.
 * 어느 쪽도 remember 흐름의 반환값을 바꾸지 않는다.
 */

import { describe, it, mock, before, beforeEach, after } from "node:test";
import assert                                             from "node:assert/strict";

const realDb     = await import("../../lib/tools/db.js");
const realLogger = await import("../../lib/logger.js");
const realEngine = await import("../../lib/memory/link/ReconsolidationEngine.js");

const warn = mock.fn();
let poolRows = [];
let quarantine = async () => [];

mock.module("../../lib/logger.js", {
  exports: { ...realLogger, logWarn: warn }
});
mock.module("../../lib/tools/db.js", {
  exports: {
    ...realDb,
    getPrimaryPool: () => ({ query: async () => ({ rows: poolRows }) })
  }
});
mock.module("../../lib/memory/link/ReconsolidationEngine.js", {
  exports: { ...realEngine, quarantineAdjacentLinks: (...args) => quarantine(...args) }
});

const { ConflictResolver }                           = await import("../../lib/memory/write/ConflictResolver.js");
const { teardownTestResources, assertCleanShutdown } = await import("../_lifecycle.js");

const NO_POLARITY_CONFLICT = { detectPolarityConflicts: async () => ({ conflicts: [] }) };
const warnings = () => warn.mock.calls.map(c => String(c.arguments[0]));
const settle   = () => new Promise(resolve => setImmediate(resolve));

let savedReconsolidation;

before(() => {
  savedReconsolidation = process.env.ENABLE_RECONSOLIDATION;
});

beforeEach(() => {
  warn.mock.resetCalls();
  poolRows   = [];
  quarantine = async () => [];
  delete process.env.ENABLE_RECONSOLIDATION;
});

after(async () => {
  if (savedReconsolidation === undefined) delete process.env.ENABLE_RECONSOLIDATION;
  else process.env.ENABLE_RECONSOLIDATION = savedReconsolidation;
  await teardownTestResources();
  await assertCleanShutdown();
});

describe("autoLinkOnRemember 조회 실패", () => {
  it("주제 조회가 실패하면 경고를 남기고 0을 돌려준다", async () => {
    const store = {
      searchByTopic: async () => { throw new Error("topic lookup down"); },
      createLink   : async () => {}
    };
    const count = await new ConflictResolver(store, {}).autoLinkOnRemember({ id: "new", topic: "t" }, "default");

    assert.equal(count, 0);
    const lines = warnings().filter(l => l.includes("autoLinkOnRemember failed"));
    assert.equal(lines.length, 1);
    assert.match(lines[0], /topic lookup down/);
  });

  it("링크 하나의 생성이 실패하는 것은 기대된 상황이라 경고하지 않고 나머지를 이어 간다", async () => {
    const created = [];
    const store   = {
      searchByTopic: async () => [{ id: "a" }, { id: "b" }],
      createLink   : async (from, to) => {
        if (to === "a") throw new Error("duplicate key");
        created.push(`${from}->${to}`);
      }
    };
    const count = await new ConflictResolver(store, {}).autoLinkOnRemember({ id: "new", topic: "t" }, "default");

    assert.equal(count, 1);
    assert.deepEqual(created, ["new->b"]);
    assert.deepEqual(warnings(), []);
  });
});

describe("인접 링크 격리 호출 실패", () => {
  const fragment = { id: "new", topic: "deploy", content: "nginx reload 후 503 해소 확인" };
  const resolver = () => new ConflictResolver({}, {}, { claimConflictDetector: NO_POLARITY_CONFLICT });

  it("격리 호출이 거부되면 경고를 남기고 판정 결과는 그대로 돌려준다", async () => {
    process.env.ENABLE_RECONSOLIDATION = "true";
    poolRows   = [{ id: "v1", content: "nginx reload 후 503 해소", assertion_status: "verified" }];
    quarantine = async () => { throw new Error("link select failed"); };

    const result = await resolver().checkAssertionConsistency(fragment, "default", null);
    await settle();

    assert.equal(result.assertionStatus, "inferred");
    assert.deepEqual(result.supersedeCandidates, ["v1"]);
    const lines = warnings().filter(l => l.includes("quarantine adjacent links failed"));
    assert.equal(lines.length, 1);
    assert.match(lines[0], /new<->v1/);
    assert.match(lines[0], /link select failed/);
  });

  it("재조정 기능이 꺼져 있으면 격리를 호출하지 않는다", async () => {
    const calls = [];
    poolRows   = [{ id: "v1", content: "nginx reload 후 503 해소", assertion_status: "verified" }];
    quarantine = async (...args) => { calls.push(args); return []; };

    await resolver().checkAssertionConsistency(fragment, "default", null);
    await settle();

    assert.deepEqual(calls, []);
    assert.deepEqual(warnings(), []);
  });
});
