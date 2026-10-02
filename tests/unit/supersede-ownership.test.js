/**
 * 명시적 대체(supersede)의 소유 조건 시험.
 * 실제 ConflictResolver.supersede를 호출하고 DB 풀과 링크 저장소만 대체한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */
import { describe, it, mock, beforeEach } from "node:test";
import assert                             from "node:assert/strict";

const OWNER   = "aaaaaaaa-0000-4000-8000-000000000001";
const OTHER   = "bbbbbbbb-0000-4000-8000-000000000002";
const OLD_ID  = "frag-aaaaaaaaaaaaaaaa";
const NEW_ID  = "frag-bbbbbbbbbbbbbbbb";
const queries = [];

const fakePool = {
  query: async (sql, params) => {
    queries.push({ sql, params });
    if (/^\s*UPDATE/i.test(sql)) {
      const keyParam = params[1];
      return { rows: keyParam === undefined || keyParam === OWNER ? [{ id: params[0], keywords: [], topic: "t", type: "fact", key_id: keyParam ?? null }] : [] };
    }
    return { rows: [] };
  }
};

const realDb = await import("../../lib/tools/db.js");
mock.module("../../lib/tools/db.js", {
  namedExports: { ...realDb, getPrimaryPool: () => fakePool }
});

const { ConflictResolver } = await import("../../lib/memory/write/ConflictResolver.js");

const links = [];
const store = { createLink: async (...args) => { links.push(args); } };

beforeEach(() => { queries.length = 0; links.length = 0; });

describe("ConflictResolver.supersede 소유 조건", () => {
  it("다른 키의 파편은 키 조건 UPDATE가 행을 돌려주지 않아 링크를 만들지 않는다", async () => {
    const cr = new ConflictResolver(store, null);
    const r  = await cr.supersede(OLD_ID, NEW_ID, "default", OTHER);
    assert.deepEqual(r, { superseded: false });
    assert.equal(links.length, 0);
    assert.equal(queries.length, 1);
    assert.match(queries[0].sql, /key_id = \$2/);
    assert.deepEqual(queries[0].params, [OLD_ID, OTHER]);
  });

  it("호출 키 소유 파편은 superseded_by 링크를 만들고 만료한다", async () => {
    const cr = new ConflictResolver(store, null);
    const r  = await cr.supersede(OLD_ID, NEW_ID, "default", OWNER);
    assert.deepEqual(r, { superseded: true });
    assert.deepEqual(links[0].slice(0, 3), [OLD_ID, NEW_ID, "superseded_by"]);
    assert.equal(queries.filter(q => /UPDATE/i.test(q.sql)).length, 1);
  });

  it("마스터(keyId null)는 소유 조건 없이 진행한다", async () => {
    const cr = new ConflictResolver(store, null);
    assert.deepEqual(await cr.supersede(OLD_ID, NEW_ID, "default", null), { superseded: true });
    assert.equal(links.length, 1);
  });
});
