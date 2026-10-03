/**
 * 관리 질의 workspace 범위 술어 실서버 검사(일회용 DB)
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 관리 처리기가 판정 범위를 ScopeFilter 술어로 붙인 질의를 실제 PostgreSQL에서 돌린다. owner 판정은 모든
 * workspace를, workspace 하나에 바인딩된 판정은 그 workspace만, 판정이 없는 요청은 빈 결과를 본다.
 * 파편 목록, 상세와 링크, 개요 수치(대체 링크 수는 양 끝이 모두 범위 안인 링크만), 키별 수치를 확인한다.
 * 관리 모듈 밖 경로를 부르는 이력과 내보내기는 질의 범위가 전체가 아니면(판정 없음 포함) 403이다.
 */
import { describe, it, before, after } from "node:test";
import assert                          from "node:assert/strict";
import pg                              from "pg";

const ADMIN_KEY = "lane-admin-key-0123456789abcdef0123456789";
process.env.MEMENTO_ACCESS_KEY = ADMIN_KEY;
process.env.EMBEDDING_BASE_URL = "http://127.0.0.1:9";

const { prepareLaneDatabase, dropLaneDatabase, directClientConfig } = await import("./_harness.js");

await prepareLaneDatabase();

const { shutdownPool }                       = await import("../../lib/tools/db.js");
const { handleMemory }                       = await import("../../lib/admin/admin-memory.js");
const { handleKeys }                         = await import("../../lib/admin/admin-keys.js");
const { handleExport }                       = await import("../../lib/admin/admin-export.js");
const { requireCapability, masterPrincipal } = await import("../../lib/admin/AdminAuthz.js");
const { ADMIN_BASE }                         = await import("../../lib/admin/admin-auth.js");

const TAG    = `scope${Date.now().toString(36)}`;
const KEY_ID = `${TAG}-key`;
const WS_A   = `${TAG}-ws-a`;
const WS_B   = `${TAG}-ws-b`;
const IDS    = { a: `${TAG}-a`, b: `${TAG}-b`, a2: `${TAG}-a2` };

let client;

function fakeRes() {
  return {
    statusCode: 200, body: "", chunks: [], headers: {},
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    write(c) { this.chunks.push(String(c)); return true; },
    end(b) { if (b !== undefined) this.body = b; }
  };
}

/** 주체 종류별 요청. owner, reviewer(WS_A 바인딩), none(판정 없음) */
function requestFor(kind, pathname, cap, workspace = null) {
  const req = { method: "GET", url: pathname, headers: {} };
  const res = fakeRes();
  const principal = kind === "owner"
    ? masterPrincipal()
    : { kind: "admin_session", id: "lane-reviewer", bindings: [{ role: "reviewer", workspace: WS_A }] };
  if (kind !== "none") assert.ok(requireCapability(req, res, { principal, cap, workspace }), `${kind} ${cap}`);
  return { req, res, url: new URL(`http://localhost${pathname}`) };
}

async function memoryGet(kind, sub, query = "") {
  const pathname = `${ADMIN_BASE}/memory${sub}${query}`;
  const { req, res, url } = requestFor(kind, pathname, "mem.read", kind === "reviewer" ? WS_A : null);
  await handleMemory(req, res, url);
  assert.equal(res.statusCode, kind === "none" && sub.startsWith("/fragments/") ? 404 : 200, `${kind} ${sub}`);
  return res.body ? JSON.parse(res.body) : null;
}

async function insertFragment(id, workspace) {
  await client.query(
    `INSERT INTO agent_memory.fragments
       (id, content, topic, keywords, type, content_hash, key_id, workspace, embedding, valid_from, created_at)
     VALUES ($1, $2, $3, ARRAY[$3]::text[], 'fact', md5($1), $4, $5, NULL, NOW(), NOW())`,
    [id, `범위 검사 본문 ${id} 충분히 길게 적는다`, TAG, KEY_ID, workspace]
  );
}

before(async () => {
  client = new pg.Client(directClientConfig());
  await client.connect();
  await client.query(
    `INSERT INTO agent_memory.api_keys (id, name, key_hash, key_prefix, permissions, status, daily_limit, created_at, symbolic_hard_gate)
     VALUES ($1, $1, md5($1), 'mmcp_x', ARRAY['read']::text[], 'active', 100, NOW(), false)`,
    [KEY_ID]
  );
  await insertFragment(IDS.a, WS_A);
  await insertFragment(IDS.b, WS_B);
  await insertFragment(IDS.a2, WS_A);
  await client.query(
    `INSERT INTO agent_memory.fragment_links (from_id, to_id, relation_type, weight)
     VALUES ($1, $2, 'related', 1), ($1, $3, 'related', 1), ($3, $1, 'superseded_by', 1), ($2, $1, 'superseded_by', 1)`,
    [IDS.a, IDS.b, IDS.a2]
  );
});

after(async () => {
  try {
    await client.end();
    await shutdownPool();
  } finally {
    await dropLaneDatabase();
  }
});

const ids = (items) => items.map((f) => f.id).filter((id) => id.startsWith(TAG)).sort();

describe("파편 목록과 상세", () => {
  it("owner는 두 workspace를, WS_A 바인딩은 WS_A만, 판정 없는 요청은 아무것도 보지 못한다", async () => {
    const query = `?topic=${TAG}`;
    assert.deepEqual(ids((await memoryGet("owner", "/fragments", query)).items), [IDS.a, IDS.a2, IDS.b].sort());
    const scoped = await memoryGet("reviewer", "/fragments", `${query}&workspace=${WS_A}`);
    assert.deepEqual(ids(scoped.items), [IDS.a, IDS.a2].sort());
    assert.equal(scoped.total, 2);
    const none = await memoryGet("none", "/fragments", query);
    assert.deepEqual(none.items, []);
    assert.equal(none.total, 0);
  });

  it("상세의 링크는 범위 안 파편만 싣고 범위 밖 파편 상세는 404다", async () => {
    const owner = await memoryGet("owner", `/fragments/${IDS.a}`);
    assert.deepEqual([...new Set(owner.links.map((l) => l.id))].sort(), [IDS.a2, IDS.b].sort());
    const scoped = await memoryGet("reviewer", `/fragments/${IDS.a}`, `?workspace=${WS_A}`);
    assert.deepEqual([...new Set(scoped.links.map((l) => l.id))], [IDS.a2]);
    const { req, res, url } = requestFor("reviewer", `${ADMIN_BASE}/memory/fragments/${IDS.b}?workspace=${WS_A}`, "mem.read", WS_A);
    await handleMemory(req, res, url);
    assert.equal(res.statusCode, 404);
    await memoryGet("none", `/fragments/${IDS.a}`);
  });
});

describe("집계와 키 수치", () => {
  it("개요 수치는 범위 안 파편만 세고 판정 없는 요청은 0이다", async () => {
    const owner  = await memoryGet("owner", "/overview");
    const scoped = await memoryGet("reviewer", "/overview", `?workspace=${WS_A}`);
    const none   = await memoryGet("none", "/overview");
    assert.ok(owner.totalFragments >= 3);
    assert.equal(scoped.byTopic.find((t) => t.topic === TAG)?.count, 2);
    assert.equal(none.totalFragments, 0);
    assert.equal(none.supersededCount, 0);
    assert.equal(owner.supersededCount, 2);
    assert.equal(scoped.supersededCount, 1);
  });

  it("키별 수치는 판정 범위로 한정된다", async () => {
    const owner = requestFor("owner", `${ADMIN_BASE}/keys/${KEY_ID}/stats`, "key.manage");
    await handleKeys(owner.req, owner.res, owner.url);
    assert.equal(JSON.parse(owner.res.body).total, 3);
    const none = requestFor("none", `${ADMIN_BASE}/keys/${KEY_ID}/stats`, "key.manage");
    await handleKeys(none.req, none.res, none.url);
    assert.equal(JSON.parse(none.res.body).total, 0);
  });
});

describe("관리 모듈 밖 경로(이력, 내보내기)", () => {
  it("owner 내보내기는 범위 술어가 붙은 조건으로 세 파편을 내보내고, 판정 없는 요청은 403이다", async () => {
    const path  = `${ADMIN_BASE}/export?key_id=${KEY_ID}`;
    const owner = requestFor("owner", path, "export.data");
    await handleExport(owner.req, owner.res, owner.url);
    const ownerLines = owner.res.chunks.join("").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(ownerLines.filter((l) => String(l.id ?? "").startsWith(TAG)).length, 3);
    const none = requestFor("none", path, "export.data");
    await handleExport(none.req, none.res, none.url);
    assert.equal(none.res.statusCode, 403);
    assert.equal(none.res.chunks.length, 0);
  });

  it("이력은 owner만 가드를 지나고 WS_A 바인딩과 판정 없는 요청은 403이며 내용을 받지 않는다", async () => {
    const path  = `${ADMIN_BASE}/memory/fragments/${IDS.b}/history`;
    const owner = requestFor("owner", path, "mem.read");
    await handleMemory(owner.req, owner.res, owner.url);
    assert.notEqual(owner.res.statusCode, 403);
    for (const kind of ["reviewer", "none"]) {
      const r = requestFor(kind, `${path}?workspace=${WS_A}`, "mem.read", WS_A);
      await handleMemory(r.req, r.res, r.url);
      assert.equal(r.res.statusCode, 403, kind);
      assert.ok(!r.res.body.includes("범위 검사 본문"), kind);
    }
  });
});
