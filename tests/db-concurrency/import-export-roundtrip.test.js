/**
 * 내보내기와 가져오기 왕복 시험 (DB)
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 시드한 데이터베이스에서 내보낸 JSON Lines를 빈 데이터베이스로 가져와 행 수, content_hash
 * 집합, 열 값, 링크, 이력, 집계가 일치하는지 시험이 계산한 값으로 비교한다. 고정 출력 문자열은
 * 쓰지 않는다. 보통 가져오기가 본문을 바꾸는 경우(저장 길이 절삭, 최소 품질 거부)와 되살리기
 * 모드가 저장된 값을 그대로 되살리는 경우, 중복, 대상 키, dryRun, 관리 API 경로를 확인한다.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert                                       from "node:assert/strict";
import crypto                                       from "node:crypto";
import pg                                           from "pg";

const {
  SCHEMA, prepareLaneDatabase, dropLaneDatabase, createExtraLaneDatabase, directQuery
} = await import("./_harness.js");

/** 앱 모듈이 풀을 만들기 전에 실행 전용 데이터베이스(가져오기 대상)를 준비한다. */
await prepareLaneDatabase();
const source = await createExtraLaneDatabase();

const { getPrimaryPool, shutdownPool } = await import("../../lib/tools/db.js");
const { exportRecords }                = await import("../../lib/memory/transfer/FragmentExporter.js");
const { ImportReport }                 = await import("../../lib/memory/transfer/ImportReport.js");
const { runImport }                    = await import("../../lib/memory/transfer/ImportRunner.js");
const { recordsFromLines }             = await import("../../lib/memory/transfer/importRecords.js");
const { loadImportRuntime }            = await import("../../lib/memory/transfer/importRuntime.js");
const { handleExport, handleImport }   = await import("../../lib/admin/admin-export.js");
const { Readable }                     = await import("node:stream");

const sha = (text) => crypto.createHash("sha256").update(text, "utf8").digest("hex");

const T0 = "2026-01-05T01:02:03.000Z";
const T1 = "2026-02-06T04:05:06.000Z";

/** 저장 규칙을 이미 지킨 행. 같은 입력을 관문에 다시 통과시켜도 값이 바뀌지 않는다. */
const COMPLIANT = [
  { id: "fr-01", content: "Redis 포트는 6380으로 운영한다", topic: "infra", type: "fact", keywords: ["redis", "port"], importance: 0.6, created_at: T0 },
  { id: "fr-02", content: "배포 직후 캐시가 비어 응답이 느려졌다", topic: "infra", type: "error", importance: 0.5, created_at: T1,
    case_id: "case-1", goal: "응답 지연 해소", outcome: "캐시 예열 추가", phase: "debugging", resolution_status: "open", assertion_status: "inferred" },
  { id: "fr-03", content: "응답 언어는 항상 한국어로 쓴다", topic: "style", type: "preference", importance: 0.9, created_at: T0, is_anchor: true },
  { id: "fr-04", content: "스테이징에서 먼저 검증한 뒤 운영에 반영한다", topic: "ops", type: "decision", importance: 0.7, created_at: T1,
    workspace: "ws-a", workspace_source: "explicit", context_summary: "배포 순서 결정", affect: "frustration" },
  { id: "fr-05", content: `긴 회고 기록 ${"나".repeat(780)}`, topic: "retro", type: "episode", importance: 0.5, created_at: T0 }
];

/** 저장 규칙 이전에 쌓인 행. 보통 가져오기는 바꾸거나 거부하고 되살리기는 그대로 되살린다. */
const LEGACY = [
  { id: "leg-long", content: `오래된 긴 본문 ${"다".repeat(440)}`, topic: "legacy", type: "fact", importance: 0.95, ttl_tier: "permanent", created_at: T0 },
  { id: "leg-short", content: "ok", topic: "legacy", type: "fact", importance: 0.4, created_at: T1 }
];

const LINKS = [
  { from_id: "fr-01", to_id: "fr-02", relation_type: "caused_by", weight: 2, confidence: 0.9, decay_rate: 0.01 },
  { from_id: "fr-02", to_id: "fr-03", relation_type: "related", weight: 1, confidence: 1, decay_rate: 0.005 },
  { from_id: "fr-04", to_id: "fr-01", relation_type: "resolved_by", weight: 1.5, confidence: 0.8, decay_rate: 0.02 }
];

const VERSIONS = [
  { fragment_id: "fr-01", content: "Redis 포트는 6379였다", topic: "infra", type: "fact", importance: 0.5, amended_by: "agent-x" },
  { fragment_id: "fr-01", content: "Redis 포트는 6381이었다", topic: "infra", type: "fact", importance: 0.5, amended_by: "agent-y" }
];

/** 원본 데이터베이스에 파편을 직접 넣는다. */
async function seedSource(client, rows, { keyId = null } = {}) {
  for (const r of rows) {
    await client.query(
      `INSERT INTO ${SCHEMA}.fragments
              (id, content, topic, keywords, type, importance, content_hash, source, agent_id, ttl_tier,
               created_at, valid_from, is_anchor, case_id, goal, outcome, phase, resolution_status, assertion_status,
               context_summary, workspace, workspace_source, affect, key_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'seed', 'default', $8, $9, $9, $10, $11, $12, $13, $14, $15, $16,
               $17, $18, $19, $20, $21)`,
      [r.id, r.content, r.topic, r.keywords ?? [], r.type, r.importance, sha(r.content), r.ttl_tier ?? "warm",
       r.created_at, r.is_anchor === true, r.case_id ?? null, r.goal ?? null, r.outcome ?? null, r.phase ?? null,
       r.resolution_status ?? null, r.assertion_status ?? "observed", r.context_summary ?? null, r.workspace ?? null,
       r.workspace_source ?? "unscoped", r.affect ?? "neutral", keyId]
    );
  }
}

async function seedLinks(client, links, { deletedPair = null } = {}) {
  for (const l of links) {
    await client.query(
      `INSERT INTO ${SCHEMA}.fragment_links (from_id, to_id, relation_type, weight, confidence, decay_rate)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [l.from_id, l.to_id, l.relation_type, l.weight, l.confidence, l.decay_rate]
    );
    await client.query(
      `UPDATE ${SCHEMA}.fragments SET linked_to = array_append(linked_to, $2) WHERE id = $1`, [l.from_id, l.to_id]
    );
    await client.query(
      `UPDATE ${SCHEMA}.fragments SET linked_to = array_append(linked_to, $1) WHERE id = $2`, [l.from_id, l.to_id]
    );
  }
  if (deletedPair) {
    await client.query(
      `INSERT INTO ${SCHEMA}.fragment_links (from_id, to_id, relation_type, deleted_at) VALUES ($1, $2, 'related', NOW())`,
      deletedPair
    );
  }
}

async function seedVersions(client, versions) {
  for (const v of versions) {
    await client.query(
      `INSERT INTO ${SCHEMA}.fragment_versions (fragment_id, content, topic, type, importance, amended_by, agent_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'default')`,
      [v.fragment_id, v.content, v.topic, v.type, v.importance, v.amended_by]
    );
  }
}

let sourceClient;
before(async () => {
  sourceClient = new pg.Client(source.config);
  await sourceClient.connect();
});

after(async () => {
  try {
    await sourceClient?.end();
    await source.drop();
  } finally {
    try {
      await shutdownPool();
    } finally {
      await dropLaneDatabase();
    }
  }
});

/** 원본 데이터베이스를 비우고 시드한다. */
async function reseedSource({ rows, links = LINKS, versions = VERSIONS, deletedPair = ["fr-03", "fr-04"] }) {
  await sourceClient.query(`TRUNCATE ${SCHEMA}.fragments CASCADE`);
  await seedSource(sourceClient, rows);
  await seedLinks(sourceClient, links, { deletedPair });
  await seedVersions(sourceClient, versions);
}

/** 원본에서 JSON Lines 줄 목록을 내보낸다. */
async function exportLines(options = {}) {
  const lines = [];
  const records = exportRecords({
    query: (sql, params) => sourceClient.query(sql, params),
    where: "valid_to IS NULL", params: [], includeVersions: true, ...options
  });
  for await (const record of records) lines.push(JSON.stringify(record));
  return lines;
}

/** 대상 데이터베이스(앱 풀)로 가져온다. */
async function importInto(lines, { restore = false, keyId = null, dryRun = false } = {}) {
  const runtime = await loadImportRuntime("cli", { keyId, restore });
  const report  = new ImportReport({ dryRun, restore });
  await runImport(recordsFromLines(lines), { ...runtime, report, pool: getPrimaryPool(), dryRun });
  return report.toJSON();
}

const FRAGMENT_COLUMNS = `id, content, content_hash, topic, type, keywords, importance, source, agent_id, ttl_tier,
  is_anchor, case_id, goal, outcome, phase, resolution_status, assertion_status, context_summary,
  workspace, workspace_source, affect, key_id, linked_to, created_at, valid_from`;

async function targetFragments() {
  const { rows } = await directQuery(`SELECT ${FRAGMENT_COLUMNS} FROM ${SCHEMA}.fragments ORDER BY id`);
  return rows;
}

async function sourceFragments() {
  const { rows } = await sourceClient.query(`SELECT ${FRAGMENT_COLUMNS} FROM ${SCHEMA}.fragments ORDER BY id`);
  return rows;
}

const linkKey = (l) => `${l.from_id}>${l.to_id}:${l.relation_type}:${Number(l.weight)}:${Number(l.confidence)}:${Number(l.decay_rate)}`;

async function linkSet(query) {
  const { rows } = await query(
    `SELECT from_id, to_id, relation_type, weight, confidence, decay_rate FROM ${SCHEMA}.fragment_links WHERE deleted_at IS NULL`
  );
  return rows.map(linkKey).sort();
}

const hashSet = (rows) => rows.map(r => r.content_hash).sort();

beforeEach(async () => {
  await directQuery(`TRUNCATE ${SCHEMA}.fragments CASCADE`);
  await directQuery(`DELETE FROM ${SCHEMA}.api_keys`);
});

describe("저장 규칙을 지킨 데이터의 왕복", () => {
  it("빈 데이터베이스에 가져오면 행 수, content_hash 집합, 열 값, 링크, 이력이 같다", async () => {
    await reseedSource({ rows: COMPLIANT });
    const lines   = await exportLines();
    const summary = await importInto(lines);

    assert.deepEqual([summary.imported, summary.duplicates, summary.rejected, summary.errors], [COMPLIANT.length, 0, 0, 0]);
    assert.deepEqual([summary.links.imported, summary.links.rejected], [LINKS.length, 0]);
    assert.equal(summary.versions.imported, VERSIONS.length);
    assert.equal(summary.transformed, 0);
    assert.deepEqual(summary.warnings, []);

    const from = await sourceFragments();
    const to   = await targetFragments();
    assert.equal(to.length, from.length);
    assert.deepEqual(hashSet(to), hashSet(from));
    for (let i = 0; i < from.length; i++) {
      for (const column of Object.keys(from[i])) {
        assert.deepEqual(to[i][column], from[i][column], `${from[i].id}.${column}`);
      }
    }

    const targetLinks = await linkSet((sql) => directQuery(sql));
    assert.deepEqual(targetLinks, await linkSet((sql) => sourceClient.query(sql)));
    assert.equal(targetLinks.length, LINKS.length);

    const versions = await directQuery(`SELECT fragment_id, content FROM ${SCHEMA}.fragment_versions ORDER BY id`);
    assert.deepEqual(versions.rows.map(r => r.content).sort(), VERSIONS.map(v => v.content).sort());
  });

  it("삭제된 링크는 내보내지 않는다", async () => {
    await reseedSource({ rows: COMPLIANT });
    const lines = await exportLines();
    const links = lines.map(l => JSON.parse(l)).filter(r => r.record === "link");
    assert.equal(links.length, LINKS.length);
    assert.ok(!links.some(l => l.from_id === "fr-03" && l.to_id === "fr-04"));
  });

  it("머리 줄의 마이그레이션 번호는 서버의 마지막 마이그레이션이고 끝 줄 수는 읽은 수와 맞는다", async () => {
    await reseedSource({ rows: COMPLIANT });
    const records = (await exportLines()).map(l => JSON.parse(l));
    const { rows } = await sourceClient.query(`SELECT max(filename) AS f FROM ${SCHEMA}.schema_migrations`);
    assert.equal(records[0].schema_migration, /migration-(\d+)/.exec(rows[0].f)[1]);
    assert.deepEqual(records.at(-1).counts, {
      fragments: COMPLIANT.length, links: LINKS.length, versions: VERSIONS.length
    });
  });

  it("같은 파일을 다시 가져오면 모든 행이 duplicates이고 행 수는 그대로다", async () => {
    await reseedSource({ rows: COMPLIANT });
    const lines = await exportLines();
    await importInto(lines);
    const again = await importInto(lines);

    assert.deepEqual([again.imported, again.duplicates], [0, COMPLIANT.length]);
    assert.deepEqual([again.links.imported, again.links.duplicates], [0, LINKS.length]);
    assert.equal(again.versions.imported, 0);
    assert.equal((await targetFragments()).length, COMPLIANT.length);
  });

  it("dryRun은 실제 실행과 같은 집계를 내고 아무것도 남기지 않는다", async () => {
    await reseedSource({ rows: COMPLIANT });
    const lines = await exportLines();
    const dry   = await importInto(lines, { dryRun: true });

    for (const table of ["fragments", "fragment_links", "fragment_versions"]) {
      const { rows } = await directQuery(`SELECT count(*)::int AS n FROM ${SCHEMA}.${table}`);
      assert.equal(rows[0].n, 0, table);
    }

    const real = await importInto(lines);
    const strip = ({ dryRun: _d, ...rest }) => rest;
    assert.deepEqual(strip(dry), strip(real));
  });

  it("관리 API 내보내기 결과를 그대로 가져오면 같은 데이터가 된다", async () => {
    await reseedSource({ rows: COMPLIANT });
    await importInto(await exportLines());
    const before = { hashes: hashSet(await targetFragments()), links: await linkSet((sql) => directQuery(sql)) };

    const chunks = [];
    const res = {
      statusCode: 0, headers: {},
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      write(c) { chunks.push(c); },
      end(body) { if (body) chunks.push(body); }
    };
    await handleExport({ method: "GET", headers: {} }, res, new URL("http://localhost/v1/internal/model/nothing/export?confirm=full&include_versions=true"));
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["x-memento-export-format-version"], "2");

    await directQuery(`TRUNCATE ${SCHEMA}.fragments CASCADE`);
    const body = chunks.join("");
    const req  = Readable.from([Buffer.from(body)]);
    req.method  = "POST";
    req.headers = { "content-type": "application/x-ndjson" };
    const out = { statusCode: 0, setHeader() {}, end(b) { this.body = b; } };
    await handleImport(req, out, new URL("http://localhost/v1/internal/model/nothing/import"), {
      queueEmbeddings: async () => async (ids) => ids.length
    });
    assert.equal(out.statusCode, 200, out.body);
    const summary = JSON.parse(out.body);
    assert.equal(summary.imported, COMPLIANT.length);
    assert.equal(summary.embedding_queued, COMPLIANT.length);

    assert.deepEqual(hashSet(await targetFragments()), before.hashes);
    assert.deepEqual(await linkSet((sql) => directQuery(sql)), before.links);
  });
});

describe("저장 규칙 이전의 행", () => {
  const ALL = [...COMPLIANT, ...LEGACY];
  const EXTRA_LINKS = [...LINKS,
    { from_id: "fr-01", to_id: "leg-long", relation_type: "related", weight: 1, confidence: 1, decay_rate: 0.005 },
    { from_id: "fr-01", to_id: "leg-short", relation_type: "related", weight: 1, confidence: 1, decay_rate: 0.005 }
  ];

  it("보통 가져오기는 긴 본문을 자르고 짧은 본문을 거부하며 그 사실을 집계에 남긴다", async () => {
    await reseedSource({ rows: ALL, links: EXTRA_LINKS });
    const summary = await importInto(await exportLines());

    assert.deepEqual([summary.imported, summary.rejected], [COMPLIANT.length + 1, 1]);
    assert.deepEqual(summary.rejected_by_reason, { input_invalid: 1, link_endpoint_missing: 1 });
    assert.equal(summary.transformed, 1);
    assert.deepEqual([summary.links.imported, summary.links.rejected], [EXTRA_LINKS.length - 1, 1]);

    const to   = await targetFragments();
    const long = to.find(r => r.id === "leg-long");
    assert.ok(long.content.length < LEGACY[0].content.length);
    assert.equal(long.content_hash, sha(long.content));
    assert.ok(!to.some(r => r.id === "leg-short"));
    assert.equal(long.ttl_tier, "warm");
    assert.ok(long.importance <= 0.7);
  });

  it("되살리기는 저장된 값 그대로 되살려 content_hash 집합과 링크가 같다", async () => {
    await reseedSource({ rows: ALL, links: EXTRA_LINKS });
    const summary = await importInto(await exportLines(), { restore: true });

    assert.deepEqual([summary.imported, summary.rejected, summary.transformed], [ALL.length, 0, 0]);
    assert.deepEqual([summary.links.imported, summary.links.rejected], [EXTRA_LINKS.length, 0]);

    const from = await sourceFragments();
    const to   = await targetFragments();
    assert.deepEqual(hashSet(to), hashSet(from));
    const long = to.find(r => r.id === "leg-long");
    assert.equal(long.importance, 0.95);
    assert.equal(long.ttl_tier, "permanent");
    assert.equal(to.find(r => r.id === "leg-short").content, "ok");
    assert.deepEqual(await linkSet((sql) => directQuery(sql)), await linkSet((sql) => sourceClient.query(sql)));
  });

  it("되살리기도 저장된 민감 정보는 다시 가린다", async () => {
    await reseedSource({ rows: [...COMPLIANT, {
      id: "leg-secret", content: "담당자 메일은 ops-team@example.com 이다", topic: "legacy", type: "fact", importance: 0.5, created_at: T0
    }], links: LINKS });
    const summary = await importInto(await exportLines(), { restore: true });
    assert.equal(summary.transformed, 1);
    const row = (await targetFragments()).find(r => r.id === "leg-secret");
    assert.ok(!row.content.includes("ops-team@example.com"));
  });
});

describe("대상 키", () => {
  async function insertTargetKey(id) {
    await directQuery(
      `INSERT INTO ${SCHEMA}.api_keys (id, name, key_hash, key_prefix) VALUES ($1, $2, $3, $4)`,
      [id, `lane-${id}`, sha(id), id.slice(0, 8)]
    );
  }

  it("대상 키로 기록하고 파일 행의 key_id는 읽지 않으며 키 범위 중복을 판정한다", async () => {
    await sourceClient.query(`TRUNCATE ${SCHEMA}.fragments CASCADE`);
    await sourceClient.query(`DELETE FROM ${SCHEMA}.api_keys`);
    await sourceClient.query(
      `INSERT INTO ${SCHEMA}.api_keys (id, name, key_hash, key_prefix) VALUES ('src-key-1', 'src', 'h-src', 'srckey01')`
    );
    const sameText = "두 키가 같은 문장을 각각 기록했다";
    await seedSource(sourceClient, [
      { id: "m-1", content: sameText, topic: "t", type: "fact", importance: 0.5, created_at: T0 },
      { id: "m-2", content: "마스터만 가진 기록이다", topic: "t", type: "fact", importance: 0.5, created_at: T0 }
    ]);
    await seedSource(sourceClient, [
      { id: "k-1", content: sameText, topic: "t", type: "fact", importance: 0.5, created_at: T0 },
      { id: "k-2", content: "키 소속으로만 가진 기록이다", topic: "t", type: "fact", importance: 0.5, created_at: T0 }
    ], { keyId: "src-key-1" });
    await seedLinks(sourceClient, [{ from_id: "k-1", to_id: "k-2", relation_type: "related", weight: 1, confidence: 1, decay_rate: 0.005 }]);

    await insertTargetKey("target-key-1");
    const summary = await importInto(await exportLines(), { keyId: "target-key-1" });

    assert.deepEqual([summary.imported, summary.duplicates, summary.rejected], [3, 1, 0]);
    assert.equal(summary.ignored.key_id, 2);
    const to = await targetFragments();
    assert.ok(to.every(r => r.key_id === "target-key-1"));
    assert.equal(to.length, 3);
    assert.equal(summary.links.imported, 1);
  });

  it("대상 키 없이 가져오면 마스터 범위(key_id NULL)이고 owner는 행의 is_anchor를 따른다", async () => {
    await reseedSource({ rows: COMPLIANT });
    await importInto(await exportLines());
    const to = await targetFragments();
    assert.ok(to.every(r => r.key_id === null));
    assert.equal(to.find(r => r.id === "fr-03").is_anchor, true);
  });
});
