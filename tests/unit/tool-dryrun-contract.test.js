/**
 * 도구 계층 dryRun 계약 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-11-02
 *
 * MemoryManager, 감사 기록기, 멱등 기록 저장소를 대체하고 실제 도구 처리기를 부른다.
 * boolean이 아닌 dryRun이 쓰기로 이어지지 않는지, 미리보기 응답이 멱등 기록으로 남지 않는지,
 * 미리보기가 없는 reflect가 dryRun을 거부하는지 본다.
 */

import { describe, it, mock, beforeEach } from "node:test";
import assert                              from "node:assert/strict";

process.env.DOTENV_CONFIG_PATH      ??= ".env.test";
process.env.MEMENTO_METRICS_DEFAULT ??= "off";
process.env.REDIS_ENABLED           ??= "false";
process.env.CACHE_ENABLED           ??= "false";

let manager = {};
const idem  = { records: new Map(), writes: 0 };

mock.module("../../lib/logging/audit-outbox.js", {
  exports: { recordAudit: async () => null, enqueueAudit: async () => null }
});
const realStore = await import("../../lib/memory/write/IdempotencyStore.js");
mock.module("../../lib/memory/write/IdempotencyStore.js", {
  namedExports: {
    ...realStore,
    findRecordedResponse: async (tool, key) => idem.records.get(`${tool}:${key}`) ?? null,
    recordResponse      : async (tool, key, response) => { idem.writes++; idem.records.set(`${tool}:${key}`, response); return true; }
  }
});
const realManager = await import("../../lib/memory/MemoryManager.js");
mock.module("../../lib/memory/MemoryManager.js", {
  namedExports: { ...realManager, MemoryManager: { getInstance: () => manager } }
});

const { tool_remember, tool_amend, tool_forget, tool_link, tool_reflect } = await import("../../lib/tools/memory.js");

const args = (extra) => ({ _defaultWorkspace: "team-a", ...extra });

beforeEach(() => {
  manager = {};
  idem.records.clear();
  idem.writes = 0;
});

describe("boolean이 아닌 dryRun", () => {
  it("remember, amend, link, forget은 처리기를 부르지 않고 거부한다", async () => {
    let calls = 0;
    const count = async () => { calls++; return { id: "frag-1", updated: true, deleted: 1 }; };
    manager = { remember: count, amend: count, link: count, forget: count };

    const results = [
      await tool_remember(args({ content: "배포 키는 매주 월요일에 교체한다", topic: "ops", type: "fact", dryRun: "true" })),
      await tool_amend(args({ id: "frag-1", content: "바뀐 본문을 충분히 길게 적는다", dryRun: "true" })),
      await tool_link(args({ fromId: "frag-1", toId: "frag-2", dryRun: 1 })),
      await tool_forget(args({ topic: "ops", dryRun: "yes" }))
    ];
    for (const res of results) {
      assert.equal(res.success, false);
      assert.match(res.error, /dryRun must be a boolean/);
    }
    assert.equal(calls, 0);
  });
});

describe("미리보기와 멱등 기록", () => {
  it("amend 미리보기는 멱등 기록을 남기지 않아 같은 키의 실제 수정이 수정된다", async () => {
    const seen = [];
    manager = {
      amend: async (a) => {
        seen.push(a.dryRun === true ? "preview" : "update");
        return a.dryRun === true ? { dryRun: true, simulated: { would_be_fragment: { id: a.id } } } : { updated: true, fragment: { id: a.id } };
      }
    };
    const preview = await tool_amend(args({ id: "frag-1", importance: 0.7, dryRun: true, idempotencyKey: "k-1" }));
    const update  = await tool_amend(args({ id: "frag-1", importance: 0.7, idempotencyKey: "k-1" }));

    assert.equal(preview.dryRun, true);
    assert.equal(update.updated, true);
    assert.equal(update.idempotentReplay, undefined);
    assert.deepEqual(seen, ["preview", "update"]);
    assert.equal(idem.writes, 1);
  });

  it("reflect는 dryRun을 멱등 기록보다 먼저 거부한다", async () => {
    let calls = 0;
    manager = { reflect: async () => { calls++; return { count: 1, fragments: [] }; } };
    const res = await tool_reflect(args({ summary: ["요약 한 줄"], dryRun: true, idempotencyKey: "r-1" }));

    assert.equal(res.success, false);
    assert.match(res.error, /does not support dryRun/);
    assert.equal(calls, 0);
    assert.equal(idem.writes, 0);
  });
});
