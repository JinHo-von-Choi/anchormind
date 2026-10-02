/**
 * 시맨틱 검색 임계값 위치 동등성 시험(일회용 DB)
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 결정적 벡터 EQ_ROWS행(기본 20000)을 넣고 무작위 질의로 inner, outer 두 형태를 비교한다.
 * 1) 정확 순서(색인 미사용)로 두 형태의 SQL을 실행하면 결과 id 집합이 모든 질의에서 같다.
 * 2) HNSW 경로에서 정확 오라클 대비 outer 재현율은 inner 이상이고,
 *    inner보다 정답을 덜 찾는 질의는 전체의 1% 이하다.
 * DATABASE_URL이 없으면 건너뛴다.
 */
import "./_cleanup.js";
import { describe, it, before, after, mock } from "node:test";
import assert                                from "node:assert/strict";
import pg                                    from "pg";

const DB_URL  = process.env.DATABASE_URL;
const ROWS    = Number(process.env.EQ_ROWS || 20000);
const QUERIES = Number(process.env.EQ_QUERIES || 300);
const TAG     = `eq${Date.now().toString(36)}`;
const KEYS    = [0, 1, 2, 3].map(i => `${TAG}-k${i}`);

const captured = [];
const realDb   = await import("../../lib/tools/db.js");
mock.module("../../lib/tools/db.js", {
  exports: {
    ...realDb,
    queryWithAgentVector: async (agentId, sql, params, opts) => {
      captured.push({ sql, params });
      return realDb.queryWithAgentVector(agentId, sql, params, opts);
    }
  }
});
const { FragmentReader } = await import("../../lib/memory/read/FragmentReader.js");

/** 결정적 난수(mulberry32)와 정규분포 */
function prng(seed) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd   = prng(20261003);
const gauss = () => Math.sqrt(-2 * Math.log(Math.max(rnd(), 1e-12))) * Math.cos(2 * Math.PI * rnd());
const pick  = arr => arr[Math.floor(rnd() * arr.length)];

let dim;
let client;
let common;
let sample = [];

function unit() {
  const v = Array.from({ length: dim }, gauss);
  const n = Math.hypot(...v);
  return v.map(x => x / n);
}
function mix(parts) {
  const v = new Array(dim).fill(0);
  for (const [w, vec] of parts) for (let i = 0; i < dim; i++) v[i] += w * vec[i];
  const n = Math.hypot(...v);
  return v.map(x => x / n);
}
const lit = v => `[${v.map(x => x.toFixed(6)).join(",")}]`;

before(async () => {
  if (!DB_URL) return;
  client = new pg.Client({ connectionString: DB_URL });
  await client.connect();
  const { rows: [col] } = await client.query(
    `SELECT atttypmod AS d FROM pg_attribute
      WHERE attrelid = 'agent_memory.fragments'::regclass AND attname = 'embedding'`);
  dim = col.d;
  for (const k of KEYS) {
    await client.query(
      `INSERT INTO agent_memory.api_keys (id, name, key_hash, key_prefix, permissions)
       VALUES ($1, $1, $1, 'mmcp_t', '{read,write}')`, [k]);
  }
  /** 공통 성분 0.35, 주제 0.25, 하위 주제 0.15, 잡음 0.25(분산 비) */
  common = unit();
  const topics = Array.from({ length: 60 }, unit);
  const subs   = Array.from({ length: 360 }, unit);
  const batch  = [];
  const flush  = async () => {
    if (batch.length === 0) return;
    const values = [];
    const params = [];
    for (const r of batch) {
      const p = params.length;
      values.push(`($${p + 1}, $${p + 1}, 't', $${p + 2}, md5($${p + 1}), $${p + 3}::vector, $${p + 4},
                    $${p + 5}, $${p + 6}, CASE WHEN $${p + 7} THEN NOW() END, 'default', 'permanent')`);
      params.push(r.id, r.type, r.vec, r.key, r.ws, r.morph, r.closed);
    }
    await client.query(
      `INSERT INTO agent_memory.fragments
         (id, content, topic, type, content_hash, embedding, key_id, workspace, morpheme_indexed, valid_to, agent_id, ttl_tier)
       VALUES ${values.join(",")}`, params);
    batch.length = 0;
  };
  const recent = [];
  for (let i = 0; i < ROWS; i++) {
    const t   = Math.floor(rnd() * 60);
    const s   = t * 6 + Math.floor(rnd() * 6);
    let   vec = mix([[Math.sqrt(0.35), common], [Math.sqrt(0.25), topics[t]], [Math.sqrt(0.15), subs[s]], [Math.sqrt(0.25), unit()]]);
    if (recent.length > 0 && rnd() < 0.02) vec = mix([[0.97, pick(recent)], [0.243, unit()]]);
    recent.push(vec); if (recent.length > 200) recent.shift();
    if (sample.length < 300 && rnd() < 0.05) sample.push(vec);
    const kr = rnd();
    batch.push({
      id    : `${TAG}-${String(i).padStart(6, "0")}`,
      type  : pick(["fact", "fact", "decision", "error", "procedure"]),
      vec   : lit(vec),
      key   : kr < 0.4 ? KEYS[0] : kr < 0.7 ? KEYS[1] : kr < 0.9 ? KEYS[2] : KEYS[3],
      ws    : rnd() < 0.15 ? null : `ws${Math.floor(rnd() * 5)}`,
      morph : rnd() < 0.7,
      closed: rnd() < 0.17
    });
    if (batch.length === 250) await flush();
  }
  await flush();
  await client.query("ANALYZE agent_memory.fragments");
});

after(async () => {
  if (!client) return;
  await client.query(`DELETE FROM agent_memory.fragments WHERE key_id = ANY($1)`, [KEYS]);
  await client.query(`DELETE FROM agent_memory.api_keys WHERE id = ANY($1)`, [KEYS]);
  await client.end();
});

/** 관련 질의(기존 행 근처)와 희소 질의(공통 성분만 공유)를 섞는다 */
function makeQuery() {
  if (rnd() < 0.55) {
    const w = 0.55 + rnd() * 0.4;
    return { kind: "related", vec: mix([[w, pick(sample)], [Math.sqrt(1 - w * w) * 0.59, common], [Math.sqrt(1 - w * w) * 0.81, unit()]]) };
  }
  return { kind: "sparse", vec: mix([[0.59, common], [0.81, unit()]]) };
}
function makeOpts() {
  const kr = rnd();
  const wr = rnd();
  const o  = {
    limit            : pick([5, 10, 30, 30]),
    minSimilarity    : pick([0.15, 0.2, 0.35, 0.4, 0.4, 0.5, 0.6, 0.75, 0.9]),
    agentId          : "default",
    keyId            : kr < 0.5 ? KEYS[0] : kr < 0.7 ? KEYS[3] : [KEYS[1], KEYS[2]],
    workspace        : wr < 0.4 ? null : `ws${Math.floor(rnd() * 5)}`,
    allWorkspaces    : false,
    includeSuperseded: rnd() < 0.1,
    morphemeOnly     : rnd() < 0.2
  };
  if (rnd() < 0.1) o.type = pick(["fact", "decision", "error"]);
  return o;
}

/** 캡처한 SQL을 색인 없이(정확 순서) 실행해 id 목록을 얻는다 */
async function exactIds({ sql, params }) {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL enable_indexscan = off");
    await client.query("SET LOCAL enable_bitmapscan = off");
    const { rows } = await client.query(sql, params);
    return rows.map(r => r.id);
  } finally {
    await client.query("COMMIT");
  }
}

async function search(mode, vec, opts) {
  process.env.MEMENTO_SEMANTIC_THRESHOLD_MODE = mode;
  captured.length = 0;
  const started = performance.now();
  const rows    = await new FragmentReader().searchBySemantic(vec, opts);
  return { ids: rows.map(r => r.id), ms: performance.now() - started, call: captured[captured.length - 1] };
}

const sameSet = (a, b) => a.length === b.length && a.every(x => b.includes(x));
const p95     = arr => [...arr].sort((x, y) => x - y)[Math.floor(arr.length * 0.95)] ?? 0;

describe("시맨틱 임계값 위치 동등성", { skip: !DB_URL }, () => {
  it("정확 순서에서 같고, HNSW에서 재현율이 떨어지지 않는다", { timeout: 900000 }, async () => {
    let exactMismatch = 0;
    let hitInner      = 0;
    let hitOuter      = 0;
    let truth         = 0;
    let regress       = 0;
    let outerShaped   = 0;
    const lat         = { inner: [], outer: [] };
    try {
      for (let q = 0; q < QUERIES; q++) {
        const { vec, kind } = makeQuery();
        const opts          = makeOpts();
        const inner         = await search("inner", vec, opts);
        const outer         = await search("outer", vec, opts);
        if (/\)\s*knn/.test(outer.call.sql)) outerShaped++;
        const exactInner    = await exactIds(inner.call);
        const exactOuter    = await exactIds(outer.call);
        if (!sameSet(exactInner, exactOuter)) exactMismatch++;
        const hi = exactInner.filter(id => inner.ids.includes(id)).length;
        const ho = exactInner.filter(id => outer.ids.includes(id)).length;
        hitInner += hi; hitOuter += ho; truth += exactInner.length;
        if (ho < hi) regress++;
        if (inner.ids.length < opts.limit) { lat.inner.push(inner.ms); lat.outer.push(outer.ms); }
        void kind;
      }
    } finally {
      delete process.env.MEMENTO_SEMANTIC_THRESHOLD_MODE;
    }
    const recallInner = hitInner / Math.max(1, truth);
    const recallOuter = hitOuter / Math.max(1, truth);
    console.log(JSON.stringify({
      queries: QUERIES, exactMismatch, recallInner: recallInner.toFixed(4), recallOuter: recallOuter.toFixed(4), regress,
      underLimit: lat.inner.length, p95InnerMs: p95(lat.inner).toFixed(1), p95OuterMs: p95(lat.outer).toFixed(1)
    }));
    assert.equal(outerShaped, QUERIES, "outer 모드는 이웃 선택 뒤 바깥에서 거르는 형태여야 한다");
    assert.equal(exactMismatch, 0, "정확 순서에서 두 형태의 결과가 달라서는 안 된다");
    assert.ok(recallOuter >= recallInner, `재현율 outer ${recallOuter} < inner ${recallInner}`);
    assert.ok(regress <= Math.ceil(QUERIES * 0.01), `inner보다 덜 찾은 질의 ${regress}건`);
  });
});
