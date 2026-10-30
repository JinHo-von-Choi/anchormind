/**
 * recall linked 미리보기의 관계 필터 실서버 시험(일회용 DB)
 *
 * 작성자: 최진호
 * 작성일: 2026-10-31
 *
 * 이슈 #103의 합성 조건(related 40, caused_by 30, resolved_by 20, part_of 10)을 실제 PostgreSQL에 넣고
 * tool_recall 응답의 fragments[].linked를 본다. linkRelationType을 주면 그 관계만 가중치 순위와 무관하게
 * 나오고, 주지 않으면 resolved_by, caused_by, related를 이 순서로 고른다. 관계 필터를 줘도 다른 키,
 * 다른 workspace, 다른 에이전트, 같은 그룹 다른 키의 검토 대기 파편, 지운 링크는 나오지 않는다.
 * 실행마다 전용 데이터베이스를 만들고 끝나면 지운다.
 */
import { describe, it, before, after } from "node:test";
import assert                          from "node:assert/strict";
import pg                              from "pg";

process.env.EMBEDDING_BASE_URL = "http://127.0.0.1:9";

const { prepareLaneDatabase, dropLaneDatabase, directClientConfig } = await import("./_harness.js");

/** 앱 모듈이 풀을 만들기 전에 실행 전용 데이터베이스를 준비한다. */
await prepareLaneDatabase();

const { shutdownPool }         = await import("../../lib/tools/db.js");
const { tool_recall }          = await import("../../lib/tools/memory.js");
const { fetchLinkedFragments } = await import("../../lib/memory/read/LinkedFragmentLoader.js");

const TAG     = `rlr${Date.now().toString(36)}`;
const KEY_A   = `${TAG}-a`;
const KEY_B   = `${TAG}-b`;
const KEY_X   = `${TAG}-x`;
const GROUP   = [KEY_A, KEY_B];
const WS      = `${TAG}-ws`;
const id      = (name) => `${TAG}-${name}`;

let client;

/** 직접 넣는 시험 파편. 검색어는 kw로만 잡히게 한다. */
async function insertRow(name, { kw = `${TAG}-other`, key = KEY_A, workspace = WS, agent = "default", state = null } = {}) {
  await client.query(
    `INSERT INTO agent_memory.fragments
       (id, content, topic, keywords, type, importance, content_hash, agent_id, valid_from, created_at,
        key_id, workspace, review_state, review_reason)
     VALUES ($1, $2, $3, ARRAY[$4]::text[], 'fact', 0.9, md5($1), $5, NOW(), NOW(), $6, $7, $8, $9)`,
    [id(name), `${name} 연결 시험 본문`, `rlr-${TAG}`, kw, agent, key, workspace, state,
      state ? "instruction_override" : null]
  );
}

async function link(from, to, relation, weight, { deleted = false } = {}) {
  await client.query(
    `INSERT INTO agent_memory.fragment_links (from_id, to_id, relation_type, weight, deleted_at)
     VALUES ($1, $2, $3, $4, ${deleted ? "NOW()" : "NULL"})`,
    [id(from), id(to), relation, weight]
  );
}

/** 검색어 kw로 recall해 source 파편의 linked를 돌려준다. */
async function linkedOf(source, kw, extra = {}) {
  const res = await tool_recall({
    keywords: [kw], agentId: "default", workspace: WS, _keyId: KEY_A, _groupKeyIds: GROUP,
    tokenBudget: 5000, fields: ["id", "topic", "linked"], ...extra
  });
  assert.equal(res.success, true, res.error);
  const frag = res.fragments.find(f => f.id === id(source));
  assert.ok(frag, `${source}가 recall 결과에 있어야 한다`);
  return frag.linked;
}

const pairs = (linked) => (linked ?? []).map(l => [l.id, l.relation_type]);

before(async () => {
  client = new pg.Client(directClientConfig());
  await client.connect();
  for (const key of [KEY_A, KEY_B, KEY_X]) {
    await client.query(
      "INSERT INTO agent_memory.api_keys (id, name, key_hash, key_prefix) VALUES ($1, $1, $1, 'lane')", [key]
    );
  }

  /** 이슈 본문의 재현 표 */
  await insertRow("S", { kw: `${TAG}-s` });
  for (const name of ["A", "B", "C", "R"]) await insertRow(name);
  await link("S", "A", "related",     40);
  await link("S", "B", "caused_by",   30);
  await link("S", "C", "resolved_by", 20);
  await link("S", "R", "part_of",     10);

  /** part_of가 여럿이면 가중치 순으로 3건 */
  await insertRow("M", { kw: `${TAG}-m` });
  for (const [n, w] of [["P1", 5], ["P2", 50], ["P3", 20], ["P4", 1], ["P5", 30]]) {
    await insertRow(n);
    await link("M", n, "part_of", w);
  }

  /** 관계 필터를 줘도 보이지 않아야 하는 part_of 대상 */
  await insertRow("G", { kw: `${TAG}-g` });
  await insertRow("ok");
  await insertRow("otherKey",   { key: KEY_X });
  await insertRow("otherWs",    { workspace: `${TAG}-ws-other` });
  await insertRow("otherAgent", { agent: `${TAG}-agent-other` });
  await insertRow("pendingB",   { key: KEY_B, state: "pending" });
  await insertRow("deletedLink");
  await link("G", "ok",          "part_of", 1);
  await link("G", "otherKey",    "part_of", 90);
  await link("G", "otherWs",     "part_of", 80);
  await link("G", "otherAgent",  "part_of", 70);
  await link("G", "pendingB",    "part_of", 60);
  await link("G", "deletedLink", "part_of", 50, { deleted: true });

  /** 나가는 링크가 없는 파편 */
  await insertRow("N", { kw: `${TAG}-n` });
  await insertRow("in");
  await link("in", "N", "part_of", 10);
});

after(async () => {
  try {
    await client.end();
    await shutdownPool();
  } finally {
    await dropLaneDatabase();
  }
});

describe("linked 미리보기 관계 필터 (#103)", () => {
  it("linkRelationType=part_of면 가중치 4순위 part_of가 나오고 다른 관계는 나오지 않는다", async () => {
    assert.deepEqual(pairs(await linkedOf("S", `${TAG}-s`, { includeLinks: true, linkRelationType: "part_of" })),
      [[id("R"), "part_of"]]);
  });

  it("다른 관계를 지정하면 그 관계만 나온다", async () => {
    assert.deepEqual(pairs(await linkedOf("S", `${TAG}-s`, { linkRelationType: "related" })), [[id("A"), "related"]]);
    assert.deepEqual(pairs(await linkedOf("S", `${TAG}-s`, { linkRelationType: "caused_by" })), [[id("B"), "caused_by"]]);
  });

  it("미지정이면 resolved_by, caused_by, related 순으로 고른다", async () => {
    assert.deepEqual(pairs(await linkedOf("S", `${TAG}-s`)),
      [[id("C"), "resolved_by"], [id("B"), "caused_by"], [id("A"), "related"]]);
  });

  it("지정한 관계의 링크가 없으면 linked가 비어 있다", async () => {
    assert.deepEqual(await linkedOf("S", `${TAG}-s`, { linkRelationType: "contradicts" }), []);
  });

  it("나가는 링크가 없으면 들어오는 part_of가 있어도 linked가 비어 있다", async () => {
    assert.deepEqual(await linkedOf("N", `${TAG}-n`, { linkRelationType: "part_of" }), []);
  });

  it("part_of가 여럿이면 가중치가 큰 3건을 그 순서로 고른다", async () => {
    assert.deepEqual(pairs(await linkedOf("M", `${TAG}-m`, { linkRelationType: "part_of" })),
      [[id("P2"), "part_of"], [id("P5"), "part_of"], [id("P3"), "part_of"]]);
  });

  it("관계 필터를 줘도 다른 키·workspace·에이전트, 같은 그룹 다른 키의 검토 대기 파편, 지운 링크는 빠진다", async () => {
    assert.deepEqual(pairs(await linkedOf("G", `${TAG}-g`, { linkRelationType: "part_of" })), [[id("ok"), "part_of"]]);
  });

  it("includeLinks=false면 linked를 조회하지 않는다", async () => {
    assert.deepEqual(await linkedOf("S", `${TAG}-s`, { includeLinks: false, linkRelationType: "part_of" }), []);
  });

  it("허용되지 않은 관계 이름은 미지정과 같게 다룬다", async () => {
    const scope = { agentId: "default", keyId: KEY_A, groupKeyIds: GROUP, workspace: WS };
    const bogus = await fetchLinkedFragments([id("S")], { ...scope, relationType: "part_of' OR 1=1 --" });
    const none  = await fetchLinkedFragments([id("S")], scope);
    assert.deepEqual(pairs(bogus.get(id("S"))), pairs(none.get(id("S"))));
    assert.deepEqual(pairs(none.get(id("S"))),
      [[id("C"), "resolved_by"], [id("B"), "caused_by"], [id("A"), "related"]]);
  });
});
