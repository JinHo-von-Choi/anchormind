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
  DEDUP_INDEXES, DEDUP_INDEX_NAMES, DEDUP_INDEX_LOOKUP_NAMES, DEDUP_INDEX_STATE_TTL_MS,
  effectiveDedupScope, conflictIndex, conflictClause, workspaceKey, pickDuplicate,
  foldKey, splitLookupHits, isDedupIndexError, loadDedupIndexes, invalidateDedupIndexes,
  normalizeWorkspace, resolveUniqueConflict, lookupRequired
} from "../../lib/memory/write/DedupScope.js";
import { dedupScope } from "../../lib/config.js";

/** 색인 상태. invalid는 pg_index에 남아 있지만 indisvalid가 아닌 색인이다. */
const st = (names, invalid = []) => ({ existing: new Set([...names, ...invalid]), valid: new Set(names) });

const LEGACY = st([DEDUP_INDEXES.keyLegacy, DEDUP_INDEXES.masterLegacy]);
const BOTH   = st(DEDUP_INDEX_NAMES);
const SCOPED = st([DEDUP_INDEXES.keyScoped, DEDUP_INDEXES.masterScoped]);
const NONE   = st([]);
/** DROP INDEX CONCURRENTLY가 키 범위 색인의 indisvalid만 내린 상태(기다리는 중이거나 중단됨) */
const DROPPING = st([DEDUP_INDEXES.keyScoped, DEDUP_INDEXES.masterScoped], [DEDUP_INDEXES.keyLegacy, DEDUP_INDEXES.masterLegacy]);

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

  it("무효 상태로 남은 키 범위 색인도 판정 범위를 키 범위로 두고 ON CONFLICT 대상에서는 빠진다", () => {
    for (const keyId of ["k1", null]) {
      assert.equal(effectiveDedupScope("workspace", DROPPING, keyId), "key");
      assert.equal(lookupRequired(DROPPING, keyId), true);
    }
    assert.equal(conflictIndex(DROPPING, "k1"), DEDUP_INDEXES.keyScoped);
    assert.equal(conflictIndex(DROPPING, null), DEDUP_INDEXES.masterScoped);
    const onlyInvalid = st([], [DEDUP_INDEXES.keyLegacy]);
    assert.equal(effectiveDedupScope("workspace", onlyInvalid, "k1"), "key");
    assert.equal(conflictIndex(onlyInvalid, "k1"), null);
    assert.equal(conflictClause(onlyInvalid, "k1"), "");
  });

  it("사전 조회는 유효한 키 범위 색인이 ON CONFLICT 대상일 때만 생략한다", () => {
    assert.equal(lookupRequired(LEGACY, "k1"), false);
    assert.equal(lookupRequired(BOTH, null), false);
    assert.equal(lookupRequired(SCOPED, "k1"), true);
    assert.equal(lookupRequired(NONE, "k1"), true);
  });

  it("경로별 색인만 본다(마스터 색인은 키 경로에 영향이 없다)", () => {
    const masterOnlyLegacy = st([DEDUP_INDEXES.masterLegacy, DEDUP_INDEXES.keyScoped]);
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

  it("NULL, '', 공백뿐인 값은 같은 칸이고 저장 값은 NULL이다", () => {
    assert.equal(workspaceKey(null), "");
    assert.equal(workspaceKey(undefined), "");
    assert.equal(workspaceKey(""), "");
    assert.equal(workspaceKey("  "), "");
    assert.equal(workspaceKey("ws"), "ws");
    assert.equal(normalizeWorkspace(""), null);
    assert.equal(normalizeWorkspace(" \t "), null);
    assert.equal(normalizeWorkspace(undefined), null);
    assert.equal(normalizeWorkspace("ws-a"), "ws-a");
    assert.equal(normalizeWorkspace(" ws-a "), " ws-a ");
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

describe("다시 판정한 뒤의 23505 정리", () => {
  const rows = [{ id: "a", workspace: "ws-a", content_hash: "h" }, { id: "g", workspace: null, content_hash: "h" }];
  const run  = async () => ({ rows });
  const dup  = (constraint) => Object.assign(new Error("dup"), { code: "23505", constraint });

  it("키 범위 색인이 막았으면 키 범위로 기존 행을 돌려준다", async () => {
    const row = await resolveUniqueConflict(async () => ({ rows: [rows[0]] }), dup(DEDUP_INDEXES.keyLegacy), { keyId: "k", contentHash: "h", workspace: "ws-b" });
    assert.equal(row.id, "a");
  });

  it("workspace 범위 색인이 막았으면 같은 칸 행을 돌려준다", async () => {
    const row = await resolveUniqueConflict(run, dup(DEDUP_INDEXES.keyScoped), { keyId: "k", contentHash: "h", workspace: "ws-a" });
    assert.equal(row.id, "a");
  });

  it("판정 색인이 아닌 오류와 기존 행이 없는 경우는 원래 오류를 던진다", async () => {
    const other = dup("idx_fragments_idempotency_tenant");
    await assert.rejects(() => resolveUniqueConflict(run, other, { keyId: "k", contentHash: "h", workspace: null }), e => e === other);
    const lost = dup(DEDUP_INDEXES.keyScoped);
    await assert.rejects(() => resolveUniqueConflict(async () => ({ rows: [] }), lost, { keyId: "k", contentHash: "h", workspace: "x" }), e => e === lost);
  });
});

describe("색인 상태 기억", () => {
  let calls;
  const run = (names, invalid = []) => async (sql, params) => {
    calls.push({ sql, params });
    return { rows: [...names.map(name => ({ name, valid: true })), ...invalid.map(name => ({ name, valid: false }))] };
  };

  beforeEach(() => {
    calls = [];
    invalidateDedupIndexes();
  });

  it("남아 있는 판정 색인과 그중 유효한 색인을 따로 읽고 결과를 기억한다", async () => {
    const state = await loadDedupIndexes(run([DEDUP_INDEXES.keyScoped], [DEDUP_INDEXES.keyLegacy]), 1000);
    assert.deepEqual([...state.existing].sort(), [DEDUP_INDEXES.keyLegacy, DEDUP_INDEXES.keyScoped].sort());
    assert.deepEqual([...state.valid], [DEDUP_INDEXES.keyScoped]);
    assert.match(calls[0].sql, /pg_index/);
    assert.match(calls[0].sql, /indisvalid AS valid/);
    assert.doesNotMatch(calls[0].sql, /AND i\.indisvalid/);
    assert.deepEqual(calls[0].params, [DEDUP_INDEX_LOOKUP_NAMES]);
    await loadDedupIndexes(run([]), 1000 + DEDUP_INDEX_STATE_TTL_MS - 1);
    assert.equal(calls.length, 1);
  });

  it("기억 시간이 지나거나 버리면 다시 읽는다", async () => {
    await loadDedupIndexes(run([DEDUP_INDEXES.keyLegacy]), 1000);
    const later = await loadDedupIndexes(run([DEDUP_INDEXES.keyScoped]), 1000 + DEDUP_INDEX_STATE_TTL_MS);
    assert.deepEqual([...later.valid], [DEDUP_INDEXES.keyScoped]);
    invalidateDedupIndexes();
    const fresh = await loadDedupIndexes(run([]), 1000 + DEDUP_INDEX_STATE_TTL_MS);
    assert.equal(fresh.existing.size, 0);
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
