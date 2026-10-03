/**
 * 저장 경로의 content_tokens 기록 단위 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 질의를 기록하는 대역 DB로 다음을 본다.
 *   1. INSERT 문 조립 도우미(appendContentTokensColumn, appendContentTokensSet, withRowContentTokens)
 *   2. contentTokensForWrite: 스위치 off, 열 없음, 열 있음
 *   3. FragmentWriter insert: 열이 있으면 본문 토큰을 to_tsvector('simple', ...)로 함께 기록하고, 없으면 열을 쓰지 않는다
 *   4. FragmentWriter update: 본문을 바꾸는 amend는 토큰을 다시 쓰고, 본문을 바꾸지 않는 amend는 쓰지 않는다
 *   5. batch_remember: 청크의 행마다 토큰을 기록한다
 */

import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert                                       from "node:assert/strict";

const db = { columnPresent: true, statements: [], rows: new Map() };

function handle(sql, params = []) {
  const text = String(sql).trim();
  db.statements.push({ sql: text, params });
  if (text.includes("column_present"))                 return { rows: [{ column_present: db.columnPresent, indexes: [] }] };
  if (text.includes("pg_index"))                       return { rows: [] };
  if (text.startsWith("SELECT id, workspace, content_hash")) return { rows: [] };
  if (/FOR UPDATE$/.test(text))                        return { rows: [db.rows.get(params[0])].filter(Boolean) };
  if (/^INSERT INTO agent_memory\.fragments\s/.test(text)) return { rows: [{ id: params[0], created: true, importance: params[5] }] };
  if (/^UPDATE agent_memory\.fragments\s/.test(text))  return { rows: [{ ...db.rows.get(params[0]) }] };
  return { rows: [] };
}

const client = { query: async (sql, params) => handle(sql, params), release: () => {} };
const pool   = { connect: async () => client, query: async (sql, params) => handle(sql, params) };

mock.module("../../lib/tools/db.js", {
  namedExports: {
    getPrimaryPool      : () => pool,
    getBatchPool        : () => pool,
    getPoolStats        : () => ({}),
    shutdownPool        : async () => {},
    withTransaction     : async (_pool, fn) => fn(client),
    queryWithAgentVector: async (_agentId, sql, params) => handle(sql, params)
  }
});

const { FragmentWriter }          = await import("../../lib/memory/write/FragmentWriter.js");
const { WriteGate }               = await import("../../lib/memory/write/WriteGate.js");
const { BatchRememberProcessor }  = await import("../../lib/memory/write/BatchRememberProcessor.js");
const { invalidateDedupIndexes }  = await import("../../lib/memory/write/DedupScope.js");
const { resetLexicalSchema }      = await import("../../lib/memory/LexicalSchema.js");
const {
  appendContentTokensColumn, appendContentTokensSet, withRowContentTokens, contentTokensForWrite, ContentTokensSqlError
} = await import("../../lib/memory/write/ContentTokens.js");

const TEXT   = "운영 서버 재시작 절차는 pgvector 색인 점검 뒤에 진행한다";
const writer = new FragmentWriter();

const inserts = () => db.statements.filter(s => /^INSERT INTO agent_memory\.fragments\s/.test(s.sql));
const updates = () => db.statements.filter(s => /^UPDATE agent_memory\.fragments\s/.test(s.sql));
const schemaQueries = () => db.statements.filter(s => s.sql.includes("column_present"));

beforeEach(() => {
  db.columnPresent     = true;
  db.statements.length = 0;
  db.rows.clear();
  resetLexicalSchema();
  invalidateDedupIndexes();
  delete process.env.MEMENTO_LEXICAL_CHANNEL;
});

afterEach(() => {
  delete process.env.MEMENTO_LEXICAL_CHANNEL;
});

describe("INSERT 문 조립 도우미", () => {
  const HEAD = "INSERT INTO agent_memory.fragments\n  (id, content)\n  VALUES ($1, $2)";

  it("열 목록과 값 목록 끝에 content_tokens를 더한다", () => {
    const out = appendContentTokensColumn(HEAD, ["a", "b"], "배포 서버");
    assert.match(out.insertHead, /\(id, content, content_tokens\)/);
    assert.match(out.insertHead, /VALUES \(\$1, \$2, to_tsvector\('simple', \$3::text\)\)$/);
    assert.deepEqual(out.insertParams, ["a", "b", "배포 서버"]);
  });

  it("문서가 undefined이면 그대로 돌려준다", () => {
    const params = ["a", "b"];
    const out    = appendContentTokensColumn(HEAD, params, undefined);
    assert.equal(out.insertHead, HEAD);
    assert.equal(out.insertParams, params);
  });

  it("빈 문서도 기록한다(빈 tsvector)", () => {
    assert.deepEqual(appendContentTokensColumn(HEAD, [], "").insertParams, [""]);
  });

  it("VALUES 절이 없는 문장은 거부한다", () => {
    assert.throws(() => appendContentTokensColumn("UPDATE x SET a = 1", [], "d"), ContentTokensSqlError);
  });

  it("SET 절 조각을 더하고 다음 자리표시자 번호를 쓴다", () => {
    const clauses = ["content = $2"];
    const params  = ["id", "본문"];
    appendContentTokensSet(clauses, params, "본문");
    assert.deepEqual(clauses, ["content = $2", "content_tokens = to_tsvector('simple', $3::text)"]);
    assert.deepEqual(params, ["id", "본문", "본문"]);
  });

  it("SET 절 문서가 undefined이면 아무것도 더하지 않는다", () => {
    const clauses = [];
    const params  = [];
    appendContentTokensSet(clauses, params, undefined);
    assert.deepEqual(clauses, []);
    assert.deepEqual(params, []);
  });

  it("다중 행 VALUES 묶음 하나에 값을 더한다", () => {
    const out = withRowContentTokens({ placeholders: "($1, $2, NULL)", values: ["a", "b"] }, 3, "doc");
    assert.equal(out.placeholders, "($1, $2, NULL, to_tsvector('simple', $3::text))");
    assert.deepEqual(out.values, ["a", "b", "doc"]);
  });
});

describe("contentTokensForWrite", () => {
  const run = (sql, params) => Promise.resolve(handle(sql, params));

  it("스위치가 off이면 카탈로그를 읽지 않고 undefined", async () => {
    process.env.MEMENTO_LEXICAL_CHANNEL = "off";
    assert.equal(await contentTokensForWrite(run, TEXT), undefined);
    assert.equal(schemaQueries().length, 0);
  });

  it("열이 없으면 undefined", async () => {
    db.columnPresent = false;
    assert.equal(await contentTokensForWrite(run, TEXT), undefined);
  });

  it("열이 있으면 본문 토큰 문서", async () => {
    const doc = await contentTokensForWrite(run, TEXT);
    for (const token of ["운영", "서버", "pgvector", "색인"]) assert.ok(doc.split(" ").includes(token), token);
  });
});

function fragment(extra = {}) {
  return { id: `f-${Math.random().toString(36).slice(2)}`, content: TEXT, topic: "ops", type: "procedure",
           importance: 0.5, agent_id: "default", key_id: "key-1", workspace: null, ...extra };
}

const insertRow = (frag, external) => writer._runInsert(external, writer._prepareInsertRow(frag));

describe("FragmentWriter insert", () => {
  for (const external of [undefined, client]) {
    const label = external ? "외부 트랜잭션" : "자체 실행";

    it(`${label}: 열이 있으면 토큰을 함께 기록한다`, async () => {
      await insertRow(fragment(), external);
      const [stmt] = inserts();
      assert.match(stmt.sql, /content_tokens\)/);
      const ref = /to_tsvector\('simple', \$(\d+)::text\)/.exec(stmt.sql);
      assert.ok(ref, stmt.sql);
      const doc = stmt.params[Number(ref[1]) - 1];
      assert.ok(doc.split(" ").includes("서버"));
      assert.equal(Number(ref[1]), stmt.params.length);
    });

    it(`${label}: 열이 없으면 content_tokens를 쓰지 않는다`, async () => {
      db.columnPresent = false;
      await insertRow(fragment(), external);
      const [stmt] = inserts();
      assert.doesNotMatch(stmt.sql, /content_tokens|to_tsvector/);
    });
  }

  it("스위치가 off이면 content_tokens를 쓰지 않는다", async () => {
    process.env.MEMENTO_LEXICAL_CHANNEL = "off";
    await insertRow(fragment());
    assert.doesNotMatch(inserts()[0].sql, /content_tokens/);
    assert.equal(schemaQueries().length, 0);
  });
});

describe("FragmentWriter update", () => {
  async function amend(id, fields) {
    const gate       = new WriteGate();
    const { fields: gated } = await gate.check({ entry: "amend", op: "update", fields, base: { type: "procedure" } });
    return writer.update(id, gated, "default", "key-1", { ...db.rows.get(id) });
  }

  beforeEach(() => {
    db.rows.set("a1", { id: "a1", content: "이전 본문 내용입니다 충분히 긴 문장", topic: "ops", type: "procedure",
                        importance: 0.5, agent_id: "default", key_id: "key-1", workspace: null, is_anchor: false });
  });

  it("본문을 바꾸면 토큰을 다시 쓴다", async () => {
    await amend("a1", { content: TEXT });
    const [stmt] = updates();
    const ref    = /content_tokens = to_tsvector\('simple', \$(\d+)::text\)/.exec(stmt.sql);
    assert.ok(ref, stmt.sql);
    assert.ok(stmt.params[Number(ref[1]) - 1].split(" ").includes("pgvector"));
  });

  it("본문을 바꾸지 않으면 토큰을 쓰지 않는다", async () => {
    await amend("a1", { topic: "ops2" });
    assert.doesNotMatch(updates()[0].sql, /content_tokens/);
  });

  it("열이 없으면 본문을 바꿔도 토큰을 쓰지 않는다", async () => {
    db.columnPresent = false;
    await amend("a1", { content: TEXT });
    assert.doesNotMatch(updates()[0].sql, /content_tokens/);
  });
});

describe("batch_remember", () => {
  function processor() {
    const factory = {
      create(item) {
        return { id: `b-${Math.random().toString(36).slice(2)}`, content: item.content, topic: item.topic, type: item.type,
                 keywords: [], importance: 0.5, content_hash: `h:${item.content}`, ttl_tier: "warm",
                 is_anchor: false, assertion_status: "observed" };
      }
    };
    const proc = new BatchRememberProcessor({ store: {}, index: { index: async () => {} }, factory });
    proc.setPool(pool);
    return proc;
  }

  const items = [
    { content: TEXT, type: "procedure", topic: "ops" },
    { content: "두 번째 파편은 Redis 세션 저장 실패를 다룬다", type: "error", topic: "ops" }
  ];

  it("행마다 토큰을 기록한다", async () => {
    const { results } = await processor().process({ fragments: items, agentId: "default", _keyId: null });
    assert.ok(results.every(r => r.success));
    const [stmt] = inserts();
    assert.match(stmt.sql, /embedding, content_tokens\)/);
    const refs = [...stmt.sql.matchAll(/to_tsvector\('simple', \$(\d+)::text\)/g)].map(m => Number(m[1]));
    assert.equal(refs.length, 2);
    assert.ok(stmt.params[refs[0] - 1].split(" ").includes("서버"));
    assert.ok(stmt.params[refs[1] - 1].split(" ").includes("세션"));
    assert.equal(refs[1], stmt.params.length);
  });

  it("열이 없으면 content_tokens를 쓰지 않는다", async () => {
    db.columnPresent = false;
    await processor().process({ fragments: items, agentId: "default", _keyId: null });
    assert.doesNotMatch(inserts()[0].sql, /content_tokens|to_tsvector/);
  });
});
