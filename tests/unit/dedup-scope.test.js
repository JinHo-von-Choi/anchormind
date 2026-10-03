/**
 * 중복 판정 범위 술어 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 색인 상태(키 범위 색인만, 두 범위 모두, workspace 범위 색인만, 없음)마다 판정 범위와
 * ON CONFLICT 대상, 기존 행 선택, batch 접기 키와 사전 조회 분리, 색인 상태 기억을 확인한다.
 */
import { describe, it, beforeEach } from "node:test";
import assert                        from "node:assert/strict";

import {
  DEDUP_INDEXES, DEDUP_INDEX_NAMES, DEDUP_INDEX_STATE_TTL_MS,
  effectiveDedupScope, conflictIndex, conflictClause, workspaceKey, pickDuplicate,
  foldKey, splitLookupHits, isDedupIndexError, loadDedupIndexes, invalidateDedupIndexes
} from "../../lib/memory/write/DedupScope.js";
import { dedupScope } from "../../lib/config.js";

const LEGACY = new Set([DEDUP_INDEXES.keyLegacy, DEDUP_INDEXES.masterLegacy]);
const BOTH   = new Set(DEDUP_INDEX_NAMES);
const SCOPED = new Set([DEDUP_INDEXES.keyScoped, DEDUP_INDEXES.masterScoped]);
const NONE   = new Set();

describe("판정 범위와 ON CONFLICT 대상", () => {
  it("키 범위 색인이 있으면 설정과 무관하게 키 범위다", () => {
    for (const present of [LEGACY, BOTH]) {
      assert.equal(effectiveDedupScope("workspace", present, "k1"), "key");
      assert.equal(effectiveDedupScope("workspace", present, null), "key");
      assert.equal(effectiveDedupScope("key", present, "k1"), "key");
    }
  });

  it("키 범위 색인이 없으면 설정을 따른다", () => {
    for (const present of [SCOPED, NONE]) {
      assert.equal(effectiveDedupScope("workspace", present, "k1"), "workspace");
      assert.equal(effectiveDedupScope("key", present, null), "key");
    }
  });

  it("경로별 색인만 본다(마스터 색인은 키 경로에 영향이 없다)", () => {
    const masterOnlyLegacy = new Set([DEDUP_INDEXES.masterLegacy, DEDUP_INDEXES.keyScoped]);
    assert.equal(effectiveDedupScope("workspace", masterOnlyLegacy, "k1"), "workspace");
    assert.equal(effectiveDedupScope("workspace", masterOnlyLegacy, null), "key");
    assert.equal(conflictIndex(masterOnlyLegacy, "k1"), DEDUP_INDEXES.keyScoped);
    assert.equal(conflictIndex(masterOnlyLegacy, null), DEDUP_INDEXES.masterLegacy);
  });

  it("ON CONFLICT 대상은 키 범위 색인, workspace 범위 색인, 없음 순이다", () => {
    assert.equal(conflictIndex(LEGACY, "k1"), DEDUP_INDEXES.keyLegacy);
    assert.equal(conflictIndex(BOTH, "k1"), DEDUP_INDEXES.keyLegacy);
    assert.equal(conflictIndex(SCOPED, "k1"), DEDUP_INDEXES.keyScoped);
    assert.equal(conflictIndex(NONE, "k1"), null);
    assert.equal(conflictIndex(BOTH, null), DEDUP_INDEXES.masterLegacy);
    assert.equal(conflictIndex(SCOPED, null), DEDUP_INDEXES.masterScoped);
  });

  it("ON CONFLICT 절은 대상 색인의 열, 식, 술어를 담고 대상이 없으면 비어 있다", () => {
    assert.match(conflictClause(LEGACY, "k1"), /^ON CONFLICT \(key_id, content_hash\) WHERE key_id IS NOT NULL DO UPDATE SET/);
    assert.match(conflictClause(LEGACY, null), /^ON CONFLICT \(content_hash\) WHERE key_id IS NULL DO UPDATE SET/);
    assert.match(conflictClause(SCOPED, "k1"), /^ON CONFLICT \(key_id, content_hash, \(COALESCE\(workspace, ''\)\)\) WHERE key_id IS NOT NULL DO UPDATE SET/);
    assert.match(conflictClause(SCOPED, null), /^ON CONFLICT \(content_hash, \(COALESCE\(workspace, ''\)\)\) WHERE key_id IS NULL DO UPDATE SET/);
    assert.match(conflictClause(SCOPED, "k1"), /GREATEST\(agent_memory\.fragments\.importance, EXCLUDED\.importance\)/);
    assert.equal(conflictClause(NONE, "k1"), "");
  });
});

describe("기존 행 선택", () => {
  const rows = [
    { id: "w1", workspace: "ws-a" },
    { id: "g",  workspace: null },
    { id: "w2", workspace: "ws-b" }
  ];

  it("NULL과 ''는 같은 칸이다", () => {
    assert.equal(workspaceKey(null), "");
    assert.equal(workspaceKey(undefined), "");
    assert.equal(workspaceKey(""), "");
    assert.equal(workspaceKey("ws"), "ws");
  });

  it("같은 workspace 행을 먼저 고른다", () => {
    assert.equal(pickDuplicate(rows, "ws-b", "workspace").id, "w2");
    assert.equal(pickDuplicate(rows, "ws-b", "key").id, "w2");
  });

  it("같은 workspace 행이 없으면 전역 행을 고른다", () => {
    assert.equal(pickDuplicate(rows, "ws-c", "workspace").id, "g");
  });

  it("전역 요청은 전역 행만 같은 칸으로 본다", () => {
    assert.equal(pickDuplicate(rows, null, "workspace").id, "g");
    assert.equal(pickDuplicate([{ id: "e", workspace: "" }], null, "workspace").id, "e");
    assert.equal(pickDuplicate([{ id: "w1", workspace: "ws-a" }], null, "workspace"), null);
  });

  it("workspace 범위는 다른 workspace 행을 고르지 않고 키 범위는 고른다", () => {
    const others = [{ id: "w1", workspace: "ws-a" }];
    assert.equal(pickDuplicate(others, "ws-b", "workspace"), null);
    assert.equal(pickDuplicate(others, "ws-b", "key").id, "w1");
    assert.equal(pickDuplicate(others, null, "key").id, "w1");
    assert.equal(pickDuplicate([], "ws-b", "key"), null);
  });
});

describe("batch 접기 키와 사전 조회 분리", () => {
  it("키 범위는 해시로, workspace 범위는 workspace와 해시로 접는다", () => {
    assert.equal(foldKey({ content_hash: "h", workspace: "a" }, "key"), "h");
    assert.notEqual(foldKey({ content_hash: "h", workspace: "a" }, "workspace"), foldKey({ content_hash: "h", workspace: "b" }, "workspace"));
    assert.equal(foldKey({ content_hash: "h", workspace: null }, "workspace"), foldKey({ content_hash: "h", workspace: "" }, "workspace"));
    assert.equal(foldKey({ workspace: "a" }, "workspace"), null);
  });

  const item = (index, workspace, hash = "h") => ({ index, fragment: { content_hash: hash, workspace } });

  it("다른 칸의 기존 행은 적중으로 가르고 같은 칸은 ON CONFLICT에 남긴다", () => {
    const rows = [{ id: "g", workspace: null, content_hash: "h" }, { id: "a", workspace: "ws-a", content_hash: "h" }];
    const { hits, rest } = splitLookupHits(
      [item(0, "ws-b"), item(1, "ws-a"), item(2, "ws-c", "other")], rows, "workspace", DEDUP_INDEXES.keyScoped
    );
    assert.deepEqual(hits, [{ index: 0, id: "g" }]);
    assert.deepEqual(rest.map(r => r.index), [1, 2]);
  });

  it("키 범위 설정이면 다른 workspace 행도 적중이다", () => {
    const rows = [{ id: "a", workspace: "ws-a", content_hash: "h" }];
    const { hits } = splitLookupHits([item(0, "ws-b")], rows, "key", DEDUP_INDEXES.keyScoped);
    assert.deepEqual(hits, [{ index: 0, id: "a" }]);
  });

  it("ON CONFLICT 대상이 없으면 같은 칸 행도 적중이다", () => {
    const rows = [{ id: "a", workspace: "ws-a", content_hash: "h" }];
    const { hits, rest } = splitLookupHits([item(0, "ws-a")], rows, "workspace", null);
    assert.deepEqual(hits, [{ index: 0, id: "a" }]);
    assert.equal(rest.length, 0);
  });
});

describe("색인 오류 판정", () => {
  it("42P10과 판정 색인의 23505만 색인 상태 오류다", () => {
    assert.equal(isDedupIndexError({ code: "42P10" }), true);
    for (const name of DEDUP_INDEX_NAMES) assert.equal(isDedupIndexError({ code: "23505", constraint: name }), true);
    assert.equal(isDedupIndexError({ code: "23505", constraint: "idx_fragments_idempotency_tenant" }), false);
    assert.equal(isDedupIndexError({ code: "40P01" }), false);
    assert.equal(isDedupIndexError(null), false);
  });
});

describe("색인 상태 기억", () => {
  let calls;
  const run = (names) => async (sql, params) => {
    calls.push({ sql, params });
    return { rows: names.map(name => ({ name })) };
  };

  beforeEach(() => {
    calls = [];
    invalidateDedupIndexes();
  });

  it("유효한 판정 색인만 묻고 결과를 기억한다", async () => {
    const present = await loadDedupIndexes(run([DEDUP_INDEXES.keyScoped]), 1000);
    assert.deepEqual([...present], [DEDUP_INDEXES.keyScoped]);
    assert.match(calls[0].sql, /pg_index/);
    assert.match(calls[0].sql, /indisvalid/);
    assert.deepEqual(calls[0].params, [DEDUP_INDEX_NAMES]);
    await loadDedupIndexes(run([]), 1000 + DEDUP_INDEX_STATE_TTL_MS - 1);
    assert.equal(calls.length, 1);
  });

  it("기억 시간이 지나거나 버리면 다시 읽는다", async () => {
    await loadDedupIndexes(run([DEDUP_INDEXES.keyLegacy]), 1000);
    const later = await loadDedupIndexes(run([DEDUP_INDEXES.keyScoped]), 1000 + DEDUP_INDEX_STATE_TTL_MS);
    assert.deepEqual([...later], [DEDUP_INDEXES.keyScoped]);
    invalidateDedupIndexes();
    const fresh = await loadDedupIndexes(run([]), 1000 + DEDUP_INDEX_STATE_TTL_MS);
    assert.equal(fresh.size, 0);
    assert.equal(calls.length, 3);
  });
});

describe("MEMENTO_DEDUP_SCOPE", () => {
  it("기본은 workspace, key는 키 범위, 그 밖의 값은 workspace", () => {
    const saved = process.env.MEMENTO_DEDUP_SCOPE;
    try {
      delete process.env.MEMENTO_DEDUP_SCOPE;
      assert.equal(dedupScope(), "workspace");
      process.env.MEMENTO_DEDUP_SCOPE = "key";
      assert.equal(dedupScope(), "key");
      process.env.MEMENTO_DEDUP_SCOPE = "tenant";
      assert.equal(dedupScope(), "workspace");
    } finally {
      if (saved === undefined) delete process.env.MEMENTO_DEDUP_SCOPE;
      else process.env.MEMENTO_DEDUP_SCOPE = saved;
    }
  });
});
