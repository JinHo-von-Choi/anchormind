/**
 * recall 조건을 LIMIT 앞에 거는지 보는 실서버 시험(일회용 DB)
 *
 * 작성자: 최진호
 * 작성일: 2026-10-31
 *
 * 그래프 이웃(L2.5), 연결 확장, 기간 계층, L3 벡터 검색은 후보를 LIMIT으로 자른다. recall 조건을 자른 뒤 JS에서
 * 걸면 조건에 맞지 않는 상위 후보가 자리를 차지해 맞는 파편이 결과에서 빠진다. 경로마다 조건에 맞는 대상 파편
 * 하나와, 순위는 더 높지만 조건에 맞지 않는 방해 파편을 둔다. 방해 파편이 있는 workspace에서도 대상 파편이
 * tool_recall 결과에 들어야 한다. 대조 workspace(방해 파편 없음)로 각 경로가 대상을 찾는다는 전제를 먼저 확인한다.
 * 질의 임베딩은 고정 벡터로 바꾸고 파편 벡터는 직접 넣는다. 실행마다 전용 데이터베이스를 만들고 끝나면 지운다.
 */
import { describe, it, before, after } from "node:test";
import assert                          from "node:assert/strict";
import pg                              from "pg";

process.env.EMBEDDING_BASE_URL = "http://127.0.0.1:9";

const { prepareLaneDatabase, dropLaneDatabase, directClientConfig } = await import("./_harness.js");

/** 앱 모듈이 풀을 만들기 전에 실행 전용 데이터베이스를 준비한다. */
await prepareLaneDatabase();

const { shutdownPool }   = await import("../../lib/tools/db.js");
const { tool_recall }    = await import("../../lib/tools/memory.js");
const { FragmentSearch } = await import("../../lib/memory/read/FragmentSearch.js");

const DIM       = 1536;
const QUERY_VEC = [1, ...Array(DIM - 1).fill(0)];
const vecOf     = (head) => `[${[...head, ...Array(DIM - head.length).fill(0)].join(",")}]`;
FragmentSearch.prototype._queryEmbedding = async () => QUERY_VEC;

const TAG   = `rfl${Date.now().toString(36)}`;
const KEY   = `${TAG}-k`;
const CLEAN = `${TAG}-clean`;
const NOISY = `${TAG}-noisy`;
const id    = (ws, name) => `${ws}-${name}`;
const ago   = (ms) => new Date(Date.now() - ms).toISOString();
const since = { from: ago(86400e3) };

let client;

async function row(ws, name, { kw = `${TAG}-x`, type = "fact", createdAt = null, affect = "neutral", phase = null, caseId = null, embedding = null } = {}) {
  await client.query(
    `INSERT INTO agent_memory.fragments
       (id, content, topic, keywords, type, importance, content_hash, agent_id, valid_from, created_at,
        key_id, workspace, affect, phase, case_id, embedding)
     VALUES ($1, $2, $3, ARRAY[$4]::text[], $5, 0.9, md5($1), 'default', NOW(), COALESCE($6::timestamptz, NOW()),
             $7, $8, $9, $10, $11, $12::vector)`,
    [id(ws, name), `${name} 조건 시험 본문`, `rfl-${TAG}`, kw, type, createdAt, KEY, ws, affect, phase, caseId, embedding]
  );
}

async function link(ws, from, to, relation, weight) {
  await client.query(
    "INSERT INTO agent_memory.fragment_links (from_id, to_id, relation_type, weight) VALUES ($1, $2, $3, $4)",
    [id(ws, from), id(ws, to), relation, weight]
  );
}

async function found(ws, name, args) {
  const res = await tool_recall({
    agentId: "default", workspace: ws, _keyId: KEY, _groupKeyIds: [KEY], tokenBudget: 20000, pageSize: 50, ...args
  });
  assert.equal(res.success, true, res.error);
  return res.fragments.some(f => f.id === id(ws, name));
}

before(async () => {
  client = new pg.Client(directClientConfig());
  await client.connect();
  await client.query("INSERT INTO agent_memory.api_keys (id, name, key_hash, key_prefix) VALUES ($1, $1, $1, 'lane')", [KEY]);

  for (const ws of [CLEAN, NOISY]) {
    /** 그래프 이웃: 조건에 맞는 이웃의 링크 가중치가 가장 낮다 */
    await row(ws, "gS", { kw: `${TAG}-g` });
    await row(ws, "gF");
    await link(ws, "gS", "gF", "part_of", 1);
    await row(ws, "cS", { kw: `${TAG}-c`, caseId: `${TAG}-case` });
    await row(ws, "cF", { caseId: `${TAG}-case` });
    await link(ws, "cS", "cF", "part_of", 1);
    /** 연결 확장: 기간 안 이웃의 링크 가중치가 가장 낮다 */
    await row(ws, "eS", { kw: `${TAG}-e`, affect: "frustration" });
    await row(ws, "eN", { createdAt: ago(2 * 3600e3), affect: "frustration" });
    await link(ws, "eS", "eN", "related", 1);
    /** 기간 계층: 검색어는 다르고 기간과 affect가 맞는 파편 */
    await row(ws, "tS", { kw: `${TAG}-t`, affect: "doubt" });
    await row(ws, "tT", { createdAt: ago(3 * 3600e3), affect: "doubt" });
    /** L3 벡터: 질의와 유사도 0.9인 phase=verification 파편 */
    await row(ws, "vV", { phase: "verification", embedding: vecOf([0.9, Math.sqrt(1 - 0.81)]) });
  }

  for (let i = 0; i < 12; i++) {
    await row(NOISY, `gD${i}`, { type: "decision" });
    await link(NOISY, "gS", `gD${i}`, "part_of", 50 + i);
    await row(NOISY, `cD${i}`);
    await link(NOISY, "cS", `cD${i}`, "part_of", 50 + i);
    await row(NOISY, `eO${i}`, { createdAt: ago(30 * 86400e3), affect: "frustration" });
    await link(NOISY, "eS", `eO${i}`, "related", 50 + i);
  }
  /** 기간 계층(최근순 30건)을 채우는 affect 불일치 파편 */
  for (let i = 0; i < 40; i++) await row(NOISY, `fill${i}`, { createdAt: ago(60e3 * (i + 1)) });
  /** 질의와 유사도 1인 phase=debugging 파편(L3 상한 30건보다 많다) */
  for (let i = 0; i < 35; i++) await row(NOISY, `vD${i}`, { phase: "debugging", embedding: vecOf([1]) });
});

after(async () => {
  try {
    await client.end();
    await shutdownPool();
  } finally {
    await dropLaneDatabase();
  }
});

const CASES = [
  ["그래프 이웃: type",        "gF", { keywords: [`${TAG}-g`], text: "조건 시험", type: "fact", includeLinks: false }],
  ["그래프 이웃: caseId",      "cF", { keywords: [`${TAG}-c`], text: "조건 시험", caseId: `${TAG}-case`, includeLinks: false }],
  ["연결 확장: timeRange",     "eN", { keywords: [`${TAG}-e`], timeRange: since, affect: "frustration" }],
  ["기간 계층: affect",        "tT", { keywords: [`${TAG}-t`], timeRange: since, affect: "doubt", includeLinks: false }],
  ["L3 벡터: phase",           "vV", { text: "검증 단계 기록", phase: "verification", includeLinks: false }]
];

describe("recall 조건을 LIMIT 앞에 건다", () => {
  for (const [label, target, args] of CASES) {
    it(`${label} — 방해 파편이 없으면 대상을 찾는다`, async () => {
      assert.ok(await found(CLEAN, target, args));
    });
    it(`${label} — 순위가 높은 방해 파편이 있어도 대상을 찾는다`, async () => {
      assert.ok(await found(NOISY, target, args));
    });
  }
});
