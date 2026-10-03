/**
 * 키 범위 색인의 다른 이름 판정 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 표를 다시 만든 설치는 키 범위 색인을 fragments_new_key_id_content_hash_idx,
 * fragments_new_content_hash_idx 이름으로 가진다. 정의가 같으면 키 범위 색인으로 싣고, 다르면 무시하고
 * 한 번 경고하며, 원래 이름이 함께 있으면 원래 이름의 행을 따르는지 확인한다.
 */
import { describe, it, beforeEach, mock } from "node:test";
import assert                              from "node:assert/strict";

const warnings = [];

mock.module("../../lib/logger.js", {
  namedExports: {
    logWarn : message => warnings.push(message),
    logInfo : () => {},
    logError: () => {},
    logDebug: () => {}
  }
});

const {
  DEDUP_INDEXES, DEDUP_INDEX_NAMES, DEDUP_INDEX_LOOKUP_NAMES, LEGACY_INDEX_ALIASES,
  legacyDefinitionMatches, indexStateFromRows, loadDedupIndexes, invalidateDedupIndexes,
  effectiveDedupScope, conflictIndex, conflictClause, lookupRequired, isDedupIndexError,
  canonicalDedupIndex, resolveUniqueConflict
} = await import("../../lib/memory/write/DedupScope.js");

const KEY_ALIAS    = "fragments_new_key_id_content_hash_idx";
const MASTER_ALIAS = "fragments_new_content_hash_idx";

/** 운영 카탈로그와 같은 모양의 다른 이름 색인 행. */
const keyAlias = (over = {}) => ({
  name: KEY_ALIAS, valid: true, unique: true, table_name: "fragments",
  columns: ["key_id", "content_hash"], predicate: "key_id IS NOT NULL", ...over
});
const masterAlias = (over = {}) => ({
  name: MASTER_ALIAS, valid: true, unique: true, table_name: "fragments",
  columns: ["content_hash"], predicate: "key_id IS NULL", ...over
});
const canonical = (name, valid = true) => ({ name, valid });

beforeEach(() => {
  warnings.length = 0;
  invalidateDedupIndexes();
});

describe("다른 이름과 정의", () => {
  it("두 다른 이름은 경로별 키 범위 색인을 대신하고 상태 질의가 함께 읽는다", () => {
    assert.deepEqual(LEGACY_INDEX_ALIASES, {
      [KEY_ALIAS]   : DEDUP_INDEXES.keyLegacy,
      [MASTER_ALIAS]: DEDUP_INDEXES.masterLegacy
    });
    assert.deepEqual([...DEDUP_INDEX_LOOKUP_NAMES], [...DEDUP_INDEX_NAMES, KEY_ALIAS, MASTER_ALIAS]);
  });

  it("같은 유일 정의(표, 키 열, 술어)만 받아들인다", () => {
    assert.equal(legacyDefinitionMatches(keyAlias(), DEDUP_INDEXES.keyLegacy), true);
    assert.equal(legacyDefinitionMatches(masterAlias(), DEDUP_INDEXES.masterLegacy), true);
    assert.equal(legacyDefinitionMatches(keyAlias({ predicate: "(key_id IS NOT NULL)" }), DEDUP_INDEXES.keyLegacy), true);
    assert.equal(legacyDefinitionMatches(keyAlias({ unique: false }), DEDUP_INDEXES.keyLegacy), false);
    assert.equal(legacyDefinitionMatches(keyAlias({ table_name: "fragments_old" }), DEDUP_INDEXES.keyLegacy), false);
    assert.equal(legacyDefinitionMatches(keyAlias({ columns: ["content_hash", "key_id"] }), DEDUP_INDEXES.keyLegacy), false);
    assert.equal(legacyDefinitionMatches(keyAlias({ columns: ["key_id", "content_hash", "workspace"] }), DEDUP_INDEXES.keyLegacy), false);
    assert.equal(legacyDefinitionMatches(keyAlias({ predicate: null }), DEDUP_INDEXES.keyLegacy), false);
    assert.equal(legacyDefinitionMatches(masterAlias({ predicate: "key_id IS NOT NULL" }), DEDUP_INDEXES.masterLegacy), false);
    assert.equal(legacyDefinitionMatches(keyAlias(), DEDUP_INDEXES.keyScoped), false);
  });
});

describe("색인 상태로 옮기기", () => {
  it("정의가 같은 다른 이름은 키 범위 색인 이름과 유효 여부로 싣는다", () => {
    const { state, aliases, sources, mismatched } = indexStateFromRows([
      keyAlias(), masterAlias({ valid: false }), canonical(DEDUP_INDEXES.keyScoped)
    ]);
    assert.deepEqual([...state.existing].sort(), [DEDUP_INDEXES.keyLegacy, DEDUP_INDEXES.masterLegacy, DEDUP_INDEXES.keyScoped].sort());
    assert.deepEqual([...state.valid].sort(), [DEDUP_INDEXES.keyLegacy, DEDUP_INDEXES.keyScoped].sort());
    assert.equal(aliases.get(KEY_ALIAS), DEDUP_INDEXES.keyLegacy);
    assert.equal(sources.get(DEDUP_INDEXES.masterLegacy), MASTER_ALIAS);
    assert.deepEqual(mismatched, []);
  });

  it("정의가 다른 다른 이름은 판정 색인으로 보지 않는다", () => {
    const { state, aliases, mismatched } = indexStateFromRows([keyAlias({ predicate: null }), canonical(DEDUP_INDEXES.keyScoped)]);
    assert.deepEqual([...state.existing], [DEDUP_INDEXES.keyScoped]);
    assert.equal(aliases.size, 0);
    assert.deepEqual(mismatched, [KEY_ALIAS]);
  });

  it("원래 이름이 함께 있으면 원래 이름의 행을 따른다", () => {
    const { state, aliases, sources } = indexStateFromRows([
      keyAlias({ valid: true }), canonical(DEDUP_INDEXES.keyLegacy, false)
    ]);
    assert.deepEqual([...state.existing], [DEDUP_INDEXES.keyLegacy]);
    assert.deepEqual([...state.valid], []);
    assert.equal(sources.has(DEDUP_INDEXES.keyLegacy), false);
    assert.equal(aliases.get(KEY_ALIAS), DEDUP_INDEXES.keyLegacy, "막은 제약 이름은 계속 알아본다");
  });
});

describe("다른 이름만 있는 설치의 판정", () => {
  const runWith = rows => async () => ({ rows });

  it("두 범위 색인이 없을 때와 있을 때 모두 키 범위로 판정하고 다른 이름 색인을 ON CONFLICT 대상으로 쓴다", async () => {
    for (const scoped of [[], [canonical(DEDUP_INDEXES.keyScoped), canonical(DEDUP_INDEXES.masterScoped)]]) {
      invalidateDedupIndexes();
      const state = await loadDedupIndexes(runWith([keyAlias(), masterAlias(), ...scoped]), 1000);
      for (const keyId of ["k1", null]) {
        assert.equal(effectiveDedupScope("workspace", state, keyId), "key");
        assert.equal(lookupRequired(state, keyId), false);
      }
      assert.equal(conflictIndex(state, "k1"), DEDUP_INDEXES.keyLegacy);
      assert.match(conflictClause(state, "k1"), /^ON CONFLICT \(key_id, content_hash\) WHERE key_id IS NOT NULL/);
      assert.match(conflictClause(state, null), /^ON CONFLICT \(content_hash\) WHERE key_id IS NULL/);
    }
  });

  it("받아들인 다른 이름의 23505는 키 범위 색인 오류로 정리한다", async () => {
    await loadDedupIndexes(runWith([keyAlias(), masterAlias()]), 1000);
    assert.equal(canonicalDedupIndex(KEY_ALIAS), DEDUP_INDEXES.keyLegacy);
    assert.equal(isDedupIndexError({ code: "23505", constraint: MASTER_ALIAS }), true);
    const err = Object.assign(new Error("dup"), { code: "23505", constraint: KEY_ALIAS });
    const row = await resolveUniqueConflict(
      async () => ({ rows: [{ id: "a", workspace: "ws-a", content_hash: "h" }] }),
      err, { keyId: "k", contentHash: "h", workspace: "ws-b" }
    );
    assert.equal(row.id, "a", "키 범위로 다른 workspace 행을 돌려준다");
  });

  it("정의가 다른 다른 이름은 무시하고 이름마다 한 번만 경고한다", async () => {
    const rows = [keyAlias({ unique: false }), canonical(DEDUP_INDEXES.keyScoped), canonical(DEDUP_INDEXES.masterScoped)];
    const state = await loadDedupIndexes(runWith(rows), 1000);
    assert.equal(effectiveDedupScope("workspace", state, "k1"), "workspace");
    assert.equal(conflictIndex(state, "k1"), DEDUP_INDEXES.keyScoped);
    assert.equal(isDedupIndexError({ code: "23505", constraint: KEY_ALIAS }), false);
    invalidateDedupIndexes();
    await loadDedupIndexes(runWith(rows), 2000);
    const aliasWarnings = warnings.filter(w => w.includes(KEY_ALIAS) && w.includes("정의가 달라"));
    assert.equal(aliasWarnings.length, 1);
  });

  it("다른 이름으로 실은 키 범위 색인은 경고에 실제 이름을 함께 적는다", async () => {
    await loadDedupIndexes(runWith([keyAlias(), canonical(DEDUP_INDEXES.masterScoped)]), 1000);
    assert.ok(warnings.some(w => w.includes(`${DEDUP_INDEXES.keyLegacy}=${KEY_ALIAS}`)));
  });
});
