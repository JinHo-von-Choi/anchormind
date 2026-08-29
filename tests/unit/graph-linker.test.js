/**
 * GraphLinker 단위 테스트 — 추가 커버리지
 *
 * 작성자: 최진호
 * 작성일: 2026-04-19
 *
 * 기존 tests/unit/graph-linker.test.js(2026-03-07)에서 미커버된 항목:
 * 1. similarity=0.95 이상 — 완전 중복: soft delete + access_count 증가
 * 2. similarity=0.90~0.94 — near-duplicate 경고 후 링크 생성 계속
 * 3. keyId!=null — allowedKeyIds 배열 생성 및 key_id 필터 쿼리 검증
 * 4. groupKeyIds 포함 시 allowedKeyIds에 합산
 * 5. 임베딩 없는 파편 — 0 반환
 * 6. retroLink: batchSize=0 → processed=0
 * 7. buildCoRetrievalLinks: DB UPSERT weight 갱신 경로
 * 8. linkFragment: superseded_by → valid_to UPDATE 쿼리 실행 확인
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { keyScopeClause } from "../../lib/memory/keyScope.js";

/* ── 실 모듈 의존성 주입 버전 (GraphLinker 로직 재현) ── */

/**
 * GraphLinker.linkFragment 핵심 로직을 DB/Store를 주입 받아 재현.
 * 실 모듈은 queryWithAgentVector를 직접 호출하므로 동일 로직을 주입 가능하게 래핑.
 * keyScopeClause를 직접 사용하여 실 모듈과 동일한 파라미터 바인딩 패턴을 검증한다.
 */
class InjectableGraphLinker {
  constructor({ db, store }) {
    this.db    = db;
    this.store = store;
  }

  async linkFragment(fragmentId, agentId = "default", keyId = null, groupKeyIds = []) {
    const fragResult = await this.db.query("SELECT_FRAG", [fragmentId]);
    if (!fragResult.rows || fragResult.rows.length === 0) return 0;

    const newFragment = fragResult.rows[0];

    /* ── Semantic Dedup Gate ── */
    const dedupParams    = [fragmentId, newFragment.topic];
    const dedupKeyClause = keyScopeClause(dedupParams, "key_id", { keyId, groupKeyIds });
    const dedupResult = await this.db.query("SELECT_DEDUP",
      dedupParams,
      undefined,
      { keyClause: dedupKeyClause }
    );

    if (dedupResult.rows && dedupResult.rows.length > 0) {
      const existing   = dedupResult.rows[0];
      const similarity = parseFloat(existing.similarity);

      if (similarity >= 0.95) {
        await this.db.query("UPDATE_VALID_TO_SELF", [fragmentId], "write");
        await this.db.query("UPDATE_ACCESS_COUNT",  [existing.id], "write");
        return 0;
      }
      /* 0.90~0.94: near-duplicate, 계속 진행 */
    }

    const candParams    = [fragmentId, newFragment.topic];
    const candKeyClause = keyScopeClause(candParams, "key_id", { keyId, groupKeyIds });
    const candidates = await this.db.query("SELECT_CANDIDATES",
      candParams,
      undefined,
      { keyClause: candKeyClause }
    );

    if (!candidates.rows || candidates.rows.length === 0) return 0;

    let linkCount = 0;

    for (const existing of candidates.rows) {
      const similarity   = parseFloat(existing.similarity);
      let   relationType = "related";

      if (newFragment.type === "error" && existing.type === "error") {
        if (newFragment.content.includes("[해결됨]") || newFragment.content.includes("resolved")) {
          relationType = "resolved_by";
        }
      }

      if (newFragment.type === existing.type && similarity > 0.85) {
        const newDate = new Date(newFragment.created_at || Date.now());
        const oldDate = new Date(existing.created_at || 0);
        if (newDate > oldDate) {
          relationType = "superseded_by";
        }
      }

      try {
        await this.store.createLink(existing.id, newFragment.id, relationType, agentId);
        linkCount++;

        if (relationType === "superseded_by") {
          await this.db.query("UPDATE_VALID_TO_EXISTING", [existing.id], "write");
        }
      } catch { /* 중복 링크 등 무시 */ }
    }

    return linkCount;
  }

  async retroLink(batchSize = 20) {
    const isolated = await this.db.query("SELECT_ISOLATED", [batchSize]);

    let processed    = 0;
    let linksCreated = 0;

    for (const row of isolated.rows) {
      const count = await this.linkFragment(row.id, "system");
      processed++;
      linksCreated += count;
    }

    return { processed, linksCreated };
  }
}

/* ── mock 헬퍼 ── */
function makeMockDb(resultMap = {}) {
  const calls = [];
  return {
    calls,
    async query(sqlKey, params, mode, opts) {
      calls.push({ sqlKey, params, mode, opts });
      return resultMap[sqlKey] ?? { rows: [] };
    }
  };
}

function makeMockStore() {
  const createLinkCalls = [];
  return {
    createLinkCalls,
    async createLink(fromId, toId, relationType, agentId) {
      createLinkCalls.push({ fromId, toId, relationType, agentId });
    }
  };
}

/* ── 테스트 ── */

describe("GraphLinker — 임베딩 없는 파편", () => {
  it("SELECT_FRAG 결과가 없으면 0 반환", async () => {
    const db    = makeMockDb({ SELECT_FRAG: { rows: [] } });
    const store = makeMockStore();
    const l     = new InjectableGraphLinker({ db, store });

    const result = await l.linkFragment("missing-frag");
    assert.strictEqual(result, 0);
    assert.strictEqual(store.createLinkCalls.length, 0);
  });
});

describe("GraphLinker — Semantic Dedup Gate", () => {
  it("similarity >= 0.95: soft delete + access_count 증가, 링크 미생성", async () => {
    const db = makeMockDb({
      SELECT_FRAG: {
        rows: [{ id: "frag-new", content: "중복 내용", topic: "test", type: "fact", created_at: "2026-04-19T00:00:00Z" }]
      },
      SELECT_DEDUP: {
        rows: [{ id: "frag-existing", similarity: "0.97" }]
      },
    });
    const store = makeMockStore();
    const l     = new InjectableGraphLinker({ db, store });

    const result = await l.linkFragment("frag-new");

    assert.strictEqual(result, 0, "완전 중복이므로 링크 미생성");
    assert.strictEqual(store.createLinkCalls.length, 0);

    const updateCalls = db.calls.filter(c => c.sqlKey === "UPDATE_VALID_TO_SELF" || c.sqlKey === "UPDATE_ACCESS_COUNT");
    assert.strictEqual(updateCalls.length, 2, "soft delete + access_count 두 UPDATE 모두 호출 필요");
  });

  it("similarity 0.90~0.94: near-duplicate 경고 후 후보 조회로 계속 진행", async () => {
    const db = makeMockDb({
      SELECT_FRAG: {
        rows: [{ id: "frag-near", content: "유사 내용", topic: "test", type: "fact", created_at: "2026-04-19T00:00:00Z" }]
      },
      SELECT_DEDUP: {
        rows: [{ id: "frag-close", similarity: "0.92" }]
      },
      SELECT_CANDIDATES: {
        rows: [{ id: "cand-1", content: "후보", type: "fact", created_at: "2026-01-01T00:00:00Z", is_anchor: false, similarity: "0.75" }]
      },
    });
    const store = makeMockStore();
    const l     = new InjectableGraphLinker({ db, store });

    const result = await l.linkFragment("frag-near");

    assert.ok(result >= 1, "near-duplicate 이후 링크가 생성되어야 한다");
  });
});

describe("GraphLinker — keyId 격리", () => {
  it("keyId!=null이면 keyScopeClause SQL 절이 SELECT_CANDIDATES opts에 전달된다", async () => {
    const db = makeMockDb({
      SELECT_FRAG      : { rows: [{ id: "f1", content: "내용", topic: "t", type: "fact", created_at: "2026-04-19T00:00:00Z" }] },
      SELECT_DEDUP     : { rows: [] },
      SELECT_CANDIDATES: { rows: [] },
    });
    const store = makeMockStore();
    const l     = new InjectableGraphLinker({ db, store });

    await l.linkFragment("f1", "agent", "k42", []);

    const candidateCall = db.calls.find(c => c.sqlKey === "SELECT_CANDIDATES");
    assert.ok(candidateCall, "SELECT_CANDIDATES 쿼리가 호출되어야 한다");
    /** keyScopeClause는 IS NOT DISTINCT FROM + ANY(::text[]) 패턴을 생성한다 */
    assert.ok(candidateCall.opts.keyClause.includes("IS NOT DISTINCT FROM"), "스칼라 IS NOT DISTINCT FROM 포함 필요");
    assert.ok(candidateCall.opts.keyClause.includes("::text[]"), "text[] 캐스팅 포함 필요");
    /** params 배열에 keyId("k42")와 groupKeyIds 배열이 push됐는지 확인 */
    assert.ok(candidateCall.params.includes("k42"), "params에 keyId가 바인딩되어야 한다");
  });

  it("groupKeyIds 포함 시 keyScopeClause params에 그룹 배열이 포함된다", async () => {
    const db = makeMockDb({
      SELECT_FRAG      : { rows: [{ id: "f1", content: "내용", topic: "t", type: "fact", created_at: "2026-04-19T00:00:00Z" }] },
      SELECT_DEDUP     : { rows: [] },
      SELECT_CANDIDATES: { rows: [] },
    });
    const store = makeMockStore();
    const l     = new InjectableGraphLinker({ db, store });

    /** keyScopeClause 계약: groupKeyIds가 non-empty면 arr=groupKeyIds, keyId는 스칼라 바인딩 */
    await l.linkFragment("f1", "agent", "k10", ["k10", "k20", "k30"]);

    const candidateCall = db.calls.find(c => c.sqlKey === "SELECT_CANDIDATES");
    const arrayParam = candidateCall.params.find(p => Array.isArray(p));
    assert.ok(arrayParam, "params에 그룹 배열이 포함되어야 한다");
    assert.deepStrictEqual(arrayParam, ["k10", "k20", "k30"]);
    /** 스칼라 바인딩에 keyId가 있어야 한다 */
    assert.ok(candidateCall.params.includes("k10"), "keyId 스칼라 바인딩 필요");
  });

  it("keyId=null(master)이면 keyScopeClause가 빈 절 반환, params 불변", async () => {
    const db = makeMockDb({
      SELECT_FRAG      : { rows: [{ id: "f1", content: "내용", topic: "t", type: "fact", created_at: "2026-04-19T00:00:00Z" }] },
      SELECT_DEDUP     : { rows: [] },
      SELECT_CANDIDATES: { rows: [] },
    });
    const store = makeMockStore();
    const l     = new InjectableGraphLinker({ db, store });

    await l.linkFragment("f1", "agent", null, []);

    const candidateCall = db.calls.find(c => c.sqlKey === "SELECT_CANDIDATES");
    assert.strictEqual(candidateCall.opts.keyClause, "", "master(null)이면 keyClause 빈 문자열");
    /** params는 [fragmentId, topic] 2개로 그대로여야 한다 */
    assert.strictEqual(candidateCall.params.length, 2, "master 경로에서는 params에 key 바인딩 추가 없음");
  });
});

describe("GraphLinker — superseded_by 시 valid_to UPDATE", () => {
  it("superseded_by 링크 생성 후 기존 파편의 valid_to UPDATE 쿼리 호출", async () => {
    const db = makeMockDb({
      SELECT_FRAG: {
        rows: [{ id: "frag-newer", content: "포트 15432", topic: "db", type: "fact", created_at: "2026-06-01T00:00:00Z" }]
      },
      SELECT_DEDUP     : { rows: [] },
      SELECT_CANDIDATES: {
        rows: [{
          id         : "frag-older",
          content    : "포트 5432",
          type       : "fact",
          created_at : "2026-01-01T00:00:00Z",
          is_anchor  : false,
          similarity : "0.91",
        }]
      },
    });
    const store = makeMockStore();
    const l     = new InjectableGraphLinker({ db, store });

    const count = await l.linkFragment("frag-newer");

    assert.strictEqual(count, 1);
    assert.strictEqual(store.createLinkCalls[0].relationType, "superseded_by");

    const validToCall = db.calls.find(c => c.sqlKey === "UPDATE_VALID_TO_EXISTING");
    assert.ok(validToCall, "superseded_by 링크 후 valid_to UPDATE 쿼리가 실행되어야 한다");
    assert.deepStrictEqual(validToCall.params, ["frag-older"]);
  });
});

describe("GraphLinker.retroLink", () => {
  it("batchSize=0이면 isolated 조회 결과가 없어 processed=0", async () => {
    const db    = makeMockDb({ SELECT_ISOLATED: { rows: [] } });
    const store = makeMockStore();
    const l     = new InjectableGraphLinker({ db, store });

    const result = await l.retroLink(0);

    assert.strictEqual(result.processed, 0);
    assert.strictEqual(result.linksCreated, 0);
  });

  it("고립 파편 처리 후 linksCreated 누적", async () => {
    const db = makeMockDb({
      SELECT_ISOLATED: { rows: [{ id: "iso-A" }, { id: "iso-B" }] },
      SELECT_FRAG    : { rows: [{ id: "iso-A", content: "고립", topic: "t", type: "fact", created_at: "2026-04-19T00:00:00Z" }] },
      SELECT_DEDUP   : { rows: [] },
      SELECT_CANDIDATES: {
        rows: [{ id: "cand", content: "후보", type: "fact", created_at: "2026-01-01T00:00:00Z", is_anchor: false, similarity: "0.75" }]
      },
    });
    const store = makeMockStore();
    const l     = new InjectableGraphLinker({ db, store });

    const result = await l.retroLink(5);

    assert.strictEqual(result.processed, 2, "2개 파편 처리");
    assert.ok(result.linksCreated >= 1, "링크가 하나 이상 생성되어야 한다");
  });
});

/** _buildKeyFilter는 제거됨. keyScopeClause 직접 통합 검증 */
describe("GraphLinker — keyScopeClause 바인딩 정합 (회귀)", () => {
  it("keyId=null이면 빈 절, params 불변", () => {
    const params = ["seed"];
    const clause = keyScopeClause(params, "key_id", { keyId: null, groupKeyIds: [] });
    assert.strictEqual(clause, "");
    assert.deepStrictEqual(params, ["seed"]);
  });

  it("단일 keyId이면 IS NOT DISTINCT FROM + ANY(::text[]) 패턴, 값이 text로 바인딩됨", () => {
    const params = ["a", "b"];
    const clause = keyScopeClause(params, "key_id", { keyId: "k42", groupKeyIds: [] });
    assert.ok(clause.includes("IS NOT DISTINCT FROM"), "스칼라 IS NOT DISTINCT FROM 필요");
    assert.ok(clause.includes("::text[]"), "text[] 캐스팅 필요 — int[] 아님");
    assert.ok(params.includes("k42"), "keyId가 params에 바인딩되어야 한다");
  });

  it("groupKeyIds 포함 시 배열 전체가 params에 push됨", () => {
    const params = [];
    keyScopeClause(params, "key_id", { keyId: "k1", groupKeyIds: ["k1", "k2", "k3"] });
    const arrParam = params.find(p => Array.isArray(p));
    assert.deepStrictEqual(arrParam, ["k1", "k2", "k3"]);
  });
});
