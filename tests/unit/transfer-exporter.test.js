/**
 * 파편 내보내기 줄 생성기 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 질의 대역 위에서 기록 순서, id 순 묶음 읽기, 링크 양 끝 조건, 이력 선택, 끝 줄 수, 버전 1 출력,
 * 상한을 확인한다. 줄 전체를 고정 문자열과 비교하지 않는다.
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";

import { exportRecords, readSchemaMigration, EXPORT_BATCH_SIZE } from "../../lib/memory/transfer/FragmentExporter.js";
import { RECORD, V1_FRAGMENT_COLUMNS, V2_FRAGMENT_COLUMNS, CURRENT_VERSION, FORMAT_NAME } from "../../lib/memory/transfer/exportFormat.js";

/**
 * 메모리 안 표 대역. SQL 문자열의 표 이름으로 어느 조회인지 가르고, 파편 조회는 id 키셋과 LIMIT을
 * 흉내 낸다.
 */
function makeQuery({ fragments = [], links = [], versions = [], migration = "migration-049-x.sql", migrationError = null } = {}) {
  const calls = [];
  const query = async (sql, params = []) => {
    calls.push({ sql, params });
    if (/schema_migrations/.test(sql)) {
      if (migrationError) throw migrationError;
      return { rows: migration ? [{ filename: migration }] : [] };
    }
    if (/FROM agent_memory\.fragments/.test(sql)) {
      const hasAfter = /AND id > \$/.test(sql);
      const after    = hasAfter ? params[params.length - 2] : null;
      const limit    = params[params.length - 1];
      const rows     = fragments.filter(f => after === null || f.id > after).sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, limit);
      return { rows };
    }
    if (/FROM agent_memory\.fragment_links/.test(sql)) return { rows: links.filter(l => params[0].includes(l.from_id)) };
    if (/FROM agent_memory\.fragment_versions/.test(sql)) return { rows: versions.filter(v => params[0].includes(v.fragment_id)) };
    throw new Error(`unexpected sql: ${sql}`);
  };
  return { query, calls };
}

async function collect(options) {
  const out = [];
  for await (const record of exportRecords({ where: "valid_to IS NULL", params: [], ...options })) out.push(record);
  return out;
}

const frag = (id) => ({ id, content: `본문 ${id}`, topic: "t", type: "fact" });

describe("exportRecords 버전 2", () => {
  it("머리 줄, 파편 줄, 링크 줄, 끝 줄 순서로 만들고 끝 줄에 수를 싣는다", async () => {
    const { query } = makeQuery({
      fragments: [frag("a"), frag("b"), frag("c")],
      links    : [{ from_id: "a", to_id: "b", relation_type: "related" }]
    });
    const records = await collect({ query });
    assert.deepEqual(records.map(r => r.record), ["header", "fragment", "fragment", "fragment", "link", "end"]);
    assert.equal(records[0].format, FORMAT_NAME);
    assert.equal(records[0].version, CURRENT_VERSION);
    assert.equal(records[0].schema_migration, "049");
    assert.deepEqual(records.at(-1).counts, { fragments: 3, links: 1, versions: 0 });
  });

  it("파편 묶음을 id 순으로 이어 읽어 묶음 경계에서 빠지거나 겹치지 않는다", async () => {
    const total     = EXPORT_BATCH_SIZE * 2 + 7;
    const fragments = Array.from({ length: total }, (_, i) => frag(`id-${String(i).padStart(5, "0")}`));
    const { query, calls } = makeQuery({ fragments });
    const records = await collect({ query, includeLinks: false });
    const ids     = records.filter(r => r.record === RECORD.FRAGMENT).map(r => r.id);
    assert.equal(ids.length, total);
    assert.equal(new Set(ids).size, total);
    assert.deepEqual(ids, [...ids].sort());
    assert.equal(calls.filter(c => /FROM agent_memory\.fragments/.test(c.sql)).length, 3);
  });

  it("양 끝이 모두 내보낸 파편인 링크만 싣는다", async () => {
    const { query } = makeQuery({
      fragments: [frag("a"), frag("b")],
      links    : [
        { from_id: "a", to_id: "b", relation_type: "related" },
        { from_id: "a", to_id: "outside", relation_type: "related" }
      ]
    });
    const links = (await collect({ query })).filter(r => r.record === RECORD.LINK);
    assert.deepEqual(links.map(l => `${l.from_id}>${l.to_id}`), ["a>b"]);
  });

  it("링크를 끄면 링크 조회도 하지 않는다", async () => {
    const { query, calls } = makeQuery({ fragments: [frag("a")] });
    const records = await collect({ query, includeLinks: false });
    assert.ok(!records.some(r => r.record === RECORD.LINK));
    assert.ok(!calls.some(c => /fragment_links/.test(c.sql)));
    assert.deepEqual(records[0].includes, [RECORD.FRAGMENT]);
  });

  it("이력은 선택했을 때만 싣는다", async () => {
    const versions = [{ fragment_id: "a", content: "옛 본문" }];
    const without = await collect({ query: makeQuery({ fragments: [frag("a")], versions }).query });
    assert.ok(!without.some(r => r.record === RECORD.VERSION));

    const withIt = await collect({ query: makeQuery({ fragments: [frag("a")], versions }).query, includeVersions: true });
    assert.equal(withIt.filter(r => r.record === RECORD.VERSION).length, 1);
    assert.equal(withIt.at(-1).counts.versions, 1);
  });

  it("상한을 주면 그 수에서 멈춘다", async () => {
    const { query } = makeQuery({ fragments: [frag("a"), frag("b"), frag("c")] });
    const records = await collect({ query, max: 2, includeLinks: false });
    assert.equal(records.filter(r => r.record === RECORD.FRAGMENT).length, 2);
    assert.equal(records.at(-1).counts.fragments, 2);
  });

  it("머리 줄에 내보내기 조건을 싣는다", async () => {
    const { query } = makeQuery({ fragments: [] });
    const [header] = await collect({ query, scope: { topic: "ops" } });
    assert.deepEqual(header.scope, { topic: "ops" });
  });

  it("조회하는 열은 버전 2 열 목록과 같다", async () => {
    const { query, calls } = makeQuery({ fragments: [frag("a")] });
    await collect({ query });
    const select = calls.find(c => /FROM agent_memory\.fragments/.test(c.sql)).sql;
    for (const column of V2_FRAGMENT_COLUMNS) assert.match(select, new RegExp(`\\b${column}\\b`));
    assert.doesNotMatch(select, /\bembedding\b/);
  });
});

describe("exportRecords 버전 1", () => {
  it("머리 줄과 끝 줄과 링크 없이 버전 1 열의 파편 줄만 만든다", async () => {
    const { query, calls } = makeQuery({ fragments: [frag("a"), frag("b")], links: [{ from_id: "a", to_id: "b" }] });
    const records = await collect({ query, version: 1 });
    assert.equal(records.length, 2);
    assert.ok(records.every(r => r.record === undefined));
    assert.ok(!calls.some(c => /schema_migrations|fragment_links/.test(c.sql)));
    const select = calls.find(c => /FROM agent_memory\.fragments/.test(c.sql)).sql;
    assert.doesNotMatch(select, /content_hash/);
    for (const column of V1_FRAGMENT_COLUMNS) assert.match(select, new RegExp(`\\b${column}\\b`));
  });
});

describe("readSchemaMigration", () => {
  it("마지막 마이그레이션 파일명에서 번호를 뽑는다", async () => {
    assert.equal(await readSchemaMigration(makeQuery({ migration: "migration-049-x.sql" }).query), "049");
  });

  it("행이 없거나 표가 없으면 null이고 다른 오류는 전파한다", async () => {
    assert.equal(await readSchemaMigration(makeQuery({ migration: null }).query), null);
    assert.equal(await readSchemaMigration(makeQuery({ migrationError: Object.assign(new Error("missing"), { code: "42P01" }) }).query), null);
    await assert.rejects(readSchemaMigration(makeQuery({ migrationError: Object.assign(new Error("down"), { code: "ECONNREFUSED" }) }).query), /down/);
  });
});
