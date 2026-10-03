/**
 * 본문 어휘 채널 실서버 시험(일회용 DB)
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 마이그레이션을 끝까지 적용한 전용 데이터베이스에서 다음을 본다.
 *   1. 마이그레이션 053은 열만 더하고 색인을 만들지 않는다(상태: 열 있음, 색인 없음)
 *   2. tsquery 생성기의 이스케이프 표가 실제 to_tsquery에서 오류 없이 읽힌다
 *   3. remember, amend, batch_remember가 content_tokens를 채우고 본문 변경 시 다시 쓴다
 *   4. 어휘 검색이 키, workspace 범위를 지키고 NULL 행은 찾지 않으며, 무효 색인이면 참여하지 않는다
 *   5. 백필 스크립트와 재개형 백필: 미리보기는 쓰지 않고, 중단 뒤 이어 가며, 읽은 뒤 본문이 바뀐 행은 쓰지 않는다
 */

import crypto                                  from "node:crypto";
import { describe, it, before, after, beforeEach } from "node:test";
import assert                                  from "node:assert/strict";

const { prepareLaneDatabase, dropLaneDatabase, directQuery, directClientConfig, SCHEMA } = await import("./_harness.js");

/** 앱 모듈이 풀을 만들기 전에 실행 전용 데이터베이스를 준비한다. */
await prepareLaneDatabase();

const { shutdownPool, getPrimaryPool }  = await import("../../lib/tools/db.js");
const { FragmentWriter }                = await import("../../lib/memory/write/FragmentWriter.js");
const { WriteGate }                     = await import("../../lib/memory/write/WriteGate.js");
const { BatchRememberProcessor }        = await import("../../lib/memory/write/BatchRememberProcessor.js");
const { FragmentFactory }               = await import("../../lib/memory/write/FragmentFactory.js");
const { LexicalSearch }                 = await import("../../lib/memory/read/LexicalSearch.js");
const { loadLexicalSchema, resetLexicalSchema } = await import("../../lib/memory/LexicalSchema.js");
const { buildLexicalTsquery }           = await import("../../lib/memory/embedding/LexicalTokens.js");
const { ensureBackfillTables, runResumableBackfill } = await import("../../lib/memory/consolidate/resumableBackfill.js");
const { contentTokenDocument }          = await import("../../lib/memory/embedding/LexicalTokens.js");
const backfillScript                    = await import("../../scripts/backfill-content-tokens.mjs");

const RUN    = `lx-${crypto.randomBytes(4).toString("hex")}`;
const KEY_A  = `${RUN}-a`;
const KEY_B  = `${RUN}-b`;
const writer = new FragmentWriter();
const run    = (sql, params) => directQuery(sql, params);

async function remember(content, { keyId = KEY_A, workspace = null, topic = RUN } = {}) {
  const gate      = new WriteGate();
  const { draft } = await gate.check({
    entry : "remember",
    op    : "create",
    fields: { content, topic, type: "fact", importance: 0.5 },
    ctx   : { keyId, agentId: "default" },
    build : (input) => ({ ...input, id: crypto.randomUUID(), agent_id: "default", key_id: keyId, workspace })
  });
  return writer.insert(draft);
}

async function amend(id, content, keyId = KEY_A) {
  const gate       = new WriteGate();
  const { fields } = await gate.check({ entry: "amend", op: "update", fields: { content }, base: { type: "fact" } });
  return writer.update(id, fields, "default", keyId);
}

async function tokensOf(id) {
  const { rows } = await directQuery(`SELECT content_tokens::text AS t FROM ${SCHEMA}.fragments WHERE id = $1`, [id]);
  return rows[0]?.t ?? null;
}

/** 시험 행을 순서가 정해진 id로 직접 넣는다(content_tokens NULL, 기존 행과 같은 상태). */
async function seedNull(prefix, contents) {
  const ids = contents.map((_, i) => `${prefix}-${String(i).padStart(3, "0")}`);
  await directQuery(
    `INSERT INTO ${SCHEMA}.fragments (id, content, type, topic, importance, ttl_tier, agent_id, keywords, content_hash, key_id)
     SELECT u.id, u.content, 'fact', $3, 0.5, 'warm', 'default', '{}', md5(u.content), $4
       FROM unnest($1::text[], $2::text[]) AS u(id, content)`,
    [ids, contents, RUN, KEY_A]
  );
  return ids;
}

before(async () => {
  for (const key of [KEY_A, KEY_B]) {
    await directQuery(`INSERT INTO ${SCHEMA}.api_keys (id, name, key_hash, key_prefix) VALUES ($1, $1, $1, 'lane')`, [key]);
  }
});

beforeEach(() => {
  resetLexicalSchema();
  delete process.env.MEMENTO_LEXICAL_CHANNEL;
});

after(async () => {
  try {
    await shutdownPool();
  } finally {
    await dropLaneDatabase();
  }
});

describe("스키마", () => {
  it("마이그레이션 053 뒤 열은 있고 GIN 색인은 없다", async () => {
    const state = await loadLexicalSchema(run);
    assert.equal(state.column, true);
    assert.equal(state.index, "absent");
    const { rows } = await directQuery(
      "SELECT data_type, is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'fragments' AND column_name = 'content_tokens'",
      [SCHEMA]);
    assert.deepEqual(rows[0], { data_type: "tsvector", is_nullable: "YES" });
  });
});

describe("tsquery 생성기와 실제 to_tsquery", () => {
  const table = [["it's"], ["a\\b"], ["\\'x"], ["a&b"], ["a|b"], ["!a"], ["(a)"], ["a:*"], ["a:AB"], ["a<->b"], ["a<2>b"],
    ["\"q\""], ["ab\u0000c"], ["memento-mcp"], ["배포", "서버", "pgvector"]];
  for (const tokens of table) {
    it(`${JSON.stringify(tokens)}`, async () => {
      const query = buildLexicalTsquery(tokens);
      const { rows } = await directQuery("SELECT to_tsquery('simple', $1)::text AS q", [query]);
      assert.equal(typeof rows[0].q, "string");
    });
  }

  it("연산자 글자는 연산자로 읽히지 않는다", async () => {
    const { rows } = await directQuery(
      "SELECT to_tsvector('simple', 'alpha beta') @@ to_tsquery('simple', $1) AS hit", [buildLexicalTsquery(["!alpha"])]);
    assert.equal(rows[0].hit, true);
  });
});

describe("저장 경로", () => {
  it("remember가 본문 토큰을 기록하고 amend가 다시 쓴다", async () => {
    const id = await remember("운영 서버 재시작 절차는 pgvector 색인 점검 뒤에 진행한다");
    assert.match(await tokensOf(id), /'서버'/);
    assert.match(await tokensOf(id), /'pgvector'/);
    await amend(id, "Redis 세션 저장 실패의 원인은 연결 제한이었다");
    const after = await tokensOf(id);
    assert.match(after, /'세션'/);
    assert.doesNotMatch(after, /'pgvector'/);
  });

  it("batch_remember가 행마다 토큰을 기록한다", async () => {
    const proc = new BatchRememberProcessor({ store: {}, index: { index: async () => {} }, factory: new FragmentFactory() });
    proc.setPool(getPrimaryPool());
    const { results } = await proc.process({
      fragments: [
        { content: "배포 스크립트는 운영자가 직접 실행한다는 규칙", topic: RUN, type: "decision" },
        { content: "HNSW 색인 재생성은 저트래픽 시간대에 한다", topic: RUN, type: "procedure" }
      ],
      agentId: "default",
      _keyId : KEY_A
    });
    assert.ok(results.every(r => r.success));
    assert.match(await tokensOf(results[0].id), /'배포'/);
    assert.match(await tokensOf(results[1].id), /'hnsw'/);
  });

  it("스위치가 off이면 토큰을 쓰지 않는다", async () => {
    process.env.MEMENTO_LEXICAL_CHANNEL = "off";
    try {
      const id = await remember("스위치가 꺼진 동안 저장한 파편의 본문");
      assert.equal(await tokensOf(id), null);
    } finally {
      delete process.env.MEMENTO_LEXICAL_CHANNEL;
    }
  });
});

describe("어휘 검색", () => {
  let mine;
  let other;
  let scoped;

  before(async () => {
    mine   = await remember("키 격리 시험: 야간 백업 스크립트가 덤프를 다른 호스트로 복사한다");
    other  = await remember("키 격리 시험: 야간 백업 스크립트가 덤프를 지운다", { keyId: KEY_B });
    scoped = await remember("키 격리 시험: 야간 백업 스크립트의 workspace 파편", { workspace: "ws-lexical" });
  });

  const search = (text, opts) => new LexicalSearch().search(text, { agentId: "default", ...opts });

  it("같은 키의 일치 파편만 찾는다", async () => {
    const ids = (await search("야간 백업 덤프", { keyId: KEY_A })).map(f => f.id);
    assert.ok(ids.includes(mine));
    assert.ok(!ids.includes(other));
  });

  it("workspace 범위를 지킨다", async () => {
    const globalOnly = (await search("야간 백업", { keyId: KEY_A })).map(f => f.id);
    assert.ok(!globalOnly.includes(scoped));
    const inWs = (await search("야간 백업", { keyId: KEY_A, workspace: "ws-lexical" })).map(f => f.id);
    assert.ok(inWs.includes(scoped));
  });

  it("점수는 0~1이고 첫 후보가 1이다", async () => {
    const rows = await search("야간 백업 덤프 호스트 복사", { keyId: KEY_A });
    assert.equal(rows[0]._lexicalScore, 1);
    assert.ok(rows.every(r => r._lexicalScore >= 0 && r._lexicalScore <= 1));
  });

  it("content_tokens가 NULL인 행은 찾지 않는다", async () => {
    const [id] = await seedNull(`${RUN}-null`, ["야간 백업 덤프 NULL 행"]);
    const ids  = (await search("야간 백업 덤프", { keyId: KEY_A })).map(f => f.id);
    assert.ok(!ids.includes(id));
  });

  it("색인이 유효하면 참여하고 무효이면 참여하지 않는다", async () => {
    await directQuery(`CREATE INDEX idx_fragments_content_tokens ON ${SCHEMA}.fragments USING gin (content_tokens)`);
    resetLexicalSchema();
    assert.equal((await loadLexicalSchema(run)).index, "valid");
    assert.ok((await search("야간 백업", { keyId: KEY_A })).length > 0);

    await directQuery(
      "UPDATE pg_index SET indisvalid = false WHERE indexrelid = 'agent_memory.idx_fragments_content_tokens'::regclass");
    resetLexicalSchema();
    assert.deepEqual(await search("야간 백업", { keyId: KEY_A }), []);
    await directQuery(`DROP INDEX ${SCHEMA}.idx_fragments_content_tokens`);
  });
});

describe("백필", () => {
  it("스크립트 미리보기는 쓰지 않고, --confirm은 NULL 행을 채운다", async () => {
    const ids = await seedNull(`${RUN}-script`, ["백필 대상 첫째 파편 본문", "백필 대상 둘째 파편 본문", "백필 대상 셋째 파편 본문"]);
    const cfg = directClientConfig();
    const env = () => ({ PGHOST: cfg.host, PGPORT: String(cfg.port), PGDATABASE: cfg.database, PGUSER: cfg.user, PGPASSWORD: cfg.password });
    const out = [];
    const io  = { out: line => out.push(line), err: line => out.push(line) };

    assert.equal(await backfillScript.main([], env(), io), 0);
    assert.equal(await tokensOf(ids[0]), null);

    assert.equal(await backfillScript.main(["--confirm", "--job", `${RUN}-job`, "--batch-size", "2"], env(), io), 0);
    for (const id of ids) assert.match(await tokensOf(id), /'파편'/, out.join("\n"));
  });

  it("중단된 작업은 같은 job으로 이어 가고, 읽은 뒤 본문이 바뀐 행은 쓰지 않는다", async () => {
    const ids = await seedNull(`${RUN}-resume`, ["이어하기 첫째 본문", "이어하기 둘째 본문", "이어하기 셋째 본문", "이어하기 넷째 본문"]);
    await ensureBackfillTables(sql => directQuery(sql));
    const job  = `${RUN}-resume-job`;
    const base = {
      job, batchSize: 2,
      where: `${backfillScript.BACKFILL_WHERE} AND topic = '${RUN}' AND id LIKE '${RUN}-resume-%'`,
      set  : backfillScript.BACKFILL_SET
    };

    let calls = 0;
    const failing = async (content) => {
      calls++;
      if (calls === 3) throw Object.assign(new Error("tokenizer stopped"), { code: "XX000" });
      return contentTokenDocument(content);
    };
    const candidateRun = (sql, params) => directQuery(sql.replace(backfillScript.BACKFILL_WHERE, base.where), params);
    await assert.rejects(runResumableBackfill({ ...base, prepareBatch: backfillScript.makePrepareBatch(candidateRun, failing) }), /tokenizer stopped/);
    assert.match(await tokensOf(ids[0]), /'첫째'/);
    assert.equal(await tokensOf(ids[2]), null);

    /** 다음 묶음을 읽은 뒤 본문이 바뀐 행(토큰 없이 해시만 바뀜)은 이전 본문의 토큰을 받지 않는다. */
    const racing = async (content) => {
      if (content.startsWith("이어하기 넷째")) {
        await directQuery(`UPDATE ${SCHEMA}.fragments SET content = 'changed', content_hash = md5('changed') WHERE id = $1`, [ids[3]]);
      }
      return contentTokenDocument(content);
    };
    const result = await runResumableBackfill({ ...base, prepareBatch: backfillScript.makePrepareBatch(candidateRun, racing) });
    assert.equal(result.resumedFrom, ids[1]);
    assert.match(await tokensOf(ids[2]), /'셋째'/);
    assert.equal(await tokensOf(ids[3]), null);
  });
});
