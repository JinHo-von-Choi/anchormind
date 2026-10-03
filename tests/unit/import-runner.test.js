/**
 * 가져오기 실행기 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 실제 WriteGate와 메모리 안의 쓰기 대역으로 집계 규칙, 형식 버전 처리, 대상 키와 권한 처리,
 * 되살리기 모드, dryRun, 임베딩 큐 투입을 확인한다. 고정 출력 문자열과 비교하지 않고 집계 값의
 * 관계와 구조를 본다.
 */

import { describe, it }  from "node:test";
import assert            from "node:assert/strict";
import crypto            from "node:crypto";

import { runImport }                       from "../../lib/memory/transfer/ImportRunner.js";
import { recordsFromLines, recordsFromJsonBody } from "../../lib/memory/transfer/importRecords.js";
import { ImportReport, MAX_REJECT_SAMPLES } from "../../lib/memory/transfer/ImportReport.js";
import { ImportAbortedError, ImportOptionError } from "../../lib/memory/transfer/importErrors.js";
import { UnsupportedFormatVersionError, V1_ACCEPTED_UNTIL } from "../../lib/memory/transfer/exportFormat.js";
import { importProfile, IMPORT_DEFAULTS }  from "../../lib/memory/write/FragmentImporter.js";
import { WriteGate, RESTORE_STEPS }        from "../../lib/memory/write/WriteGate.js";
import { SymbolicPolicyViolationError }    from "../../lib/symbolic/errors.js";

const sha = (text) => crypto.createHash("sha256").update(text, "utf8").digest("hex");

/** 메모리 안 저장소. 같은 키 범위의 같은 본문 해시는 중복, 같은 id는 고유 제약 위반이다. */
function makeStore() {
  const rows     = new Map();
  const links    = new Map();
  const versions = [];
  const calls    = [];
  const writer = {
    async insertDetailed(draft, opts) {
      calls.push({ draft, opts });
      const hash  = sha(draft.content);
      const twin  = [...rows.values()].find(r => r.hash === hash && r.draft.key_id === draft.key_id);
      if (twin) return { id: twin.draft.id, created: false };
      if (rows.has(draft.id)) throw Object.assign(new Error("duplicate key"), { code: "23505" });
      if (draft.content === "__db_error__") throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
      rows.set(draft.id, { draft, hash });
      return { id: draft.id, created: true };
    },
    async restoreVersion(row) { versions.push(row); }
  };
  const linkStore = {
    async restoreLink(_client, link) {
      const key = `${link.from_id}>${link.to_id}`;
      if (links.has(key)) return { created: false };
      links.set(key, link);
      return { created: true };
    }
  };
  return { rows, links, versions, calls, writer, linkStore };
}

/** 문장 목록을 기록하는 client와 pool 대역. */
function makeDb() {
  const statements = [];
  const client = {
    query  : async (sql) => { statements.push(String(sql).trim().split(/\s+/).slice(0, 2).join(" ")); return { rows: [] }; },
    release() {}
  };
  return {
    statements,
    pool           : { connect: async () => client },
    withTransaction: async (_pool, fn) => fn(client)
  };
}

/** 실행기 의존성을 만들어 줄 목록을 가져온다. */
async function run(lines, {
  profile = importProfile(IMPORT_DEFAULTS.cli, { owner: true }), steps = {}, dryRun = false, idempotent = false,
  failFast = false, store = makeStore(), db = makeDb(), onCreated, gate
} = {}) {
  const report = new ImportReport({ dryRun, restore: profile.restore });
  await runImport(recordsFromLines(lines), {
    report, profile, entry: "cli_import", gate: gate ?? new WriteGate({ steps }),
    writer: store.writer, linkStore: store.linkStore,
    pool: db.pool, withTransaction: db.withTransaction,
    dryRun, idempotent, failFast, onCreated
  });
  return { report, summary: report.toJSON(), store, db };
}

const line = (obj) => JSON.stringify(obj);
const frag = (id, content, extra = {}) => line({ record: "fragment", id, content, topic: "ops", type: "fact", ...extra });
const header = (version = 2) => line({ record: "header", format: "memento-fragments", version, schema_migration: "049" });
const trailer = (counts) => line({ record: "end", counts });

const LONG = "가".repeat(500);

describe("형식 버전", () => {
  it("머리 줄이 없는 파일은 버전 1이고 폐지 예정 표시와 수용 기한을 응답에 싣는다", async () => {
    const { summary } = await run([line({ id: "a", content: "Redis 포트는 6380으로 운영한다", topic: "ops" })]);
    assert.equal(summary.format.version, 1);
    assert.equal(summary.format.deprecated, true);
    assert.equal(summary.format.accepted_until, V1_ACCEPTED_UNTIL);
    assert.equal(summary.imported, 1);
  });

  it("버전 2 머리 줄은 폐지 표시 없이 버전만 싣는다", async () => {
    const { summary } = await run([header(), frag("a", "Redis 포트는 6380으로 운영한다"), trailer({ fragments: 1, links: 0, versions: 0 })]);
    assert.equal(summary.format.version, 2);
    assert.equal(summary.format.deprecated, undefined);
    assert.deepEqual(summary.warnings, []);
  });

  it("읽을 수 없는 버전의 머리 줄은 아무것도 기록하기 전에 UnsupportedFormatVersionError로 중단한다", async () => {
    const store = makeStore();
    await assert.rejects(run([header(3), frag("a", "Redis 포트는 6380으로 운영한다")], { store }), UnsupportedFormatVersionError);
    assert.equal(store.rows.size, 0);
  });

  it("버전 1 파일의 링크와 이력 줄은 invalid_record로 거부한다", async () => {
    const { summary } = await run([
      line({ id: "a", content: "Redis 포트는 6380으로 운영한다", topic: "ops" }),
      line({ record: "link", from_id: "a", to_id: "b" }),
      line({ record: "version", fragment_id: "a", content: "이전 본문 내용입니다" })
    ]);
    assert.deepEqual(summary.rejected_by_reason, { invalid_record: 2 });
    assert.equal(summary.links.rejected, 1);
    assert.equal(summary.versions.rejected, 1);
  });

  it("처음이 아닌 위치의 머리 줄은 경고만 남기고 무시한다", async () => {
    const { summary } = await run([header(), frag("a", "Redis 포트는 6380으로 운영한다"), header()]);
    assert.ok(summary.warnings.some(w => w.code === "header_not_first"));
    assert.equal(summary.imported, 1);
  });

  it("JSON 본문 형태도 같은 실행기로 처리한다", async () => {
    const store  = makeStore();
    const db     = makeDb();
    const report = new ImportReport();
    await runImport(recordsFromJsonBody({
      fragments: [{ id: "a", content: "Redis 포트는 6380으로 운영한다", topic: "ops" }, { id: "b", content: "Nginx는 3999 포트에서 받는다", topic: "ops" }],
      links    : [{ from_id: "a", to_id: "b", relation_type: "related" }]
    }), {
      report, profile: importProfile(IMPORT_DEFAULTS.admin, { owner: true }), entry: "admin_import", gate: new WriteGate(),
      writer: store.writer, linkStore: store.linkStore, pool: db.pool, withTransaction: db.withTransaction
    });
    const summary = report.toJSON();
    assert.deepEqual([summary.imported, summary.links.imported], [2, 1]);
    assert.equal(summary.format.version, 2);
  });
});

describe("집계", () => {
  it("행은 imported, duplicates, rejected, errors 중 하나에만 들어가고 합이 줄 수와 같다", async () => {
    const lines = [
      frag("a", "Redis 포트는 6380으로 운영한다"),
      frag("b", "Redis 포트는 6380으로 운영한다"),
      frag("c", "짧음"),
      line({ record: "fragment", id: "d", topic: "ops" }),
      "{broken",
      frag("e", "__db_error__")
    ];
    const { summary } = await run(lines);
    assert.deepEqual([summary.imported, summary.duplicates, summary.rejected, summary.errors], [1, 1, 3, 1]);
    assert.equal(summary.imported + summary.duplicates + summary.rejected + summary.errors, lines.length);
    assert.deepEqual(summary.rejected_by_reason, { input_invalid: 1, invalid_row: 1, invalid_json: 1 });
  });

  it("같은 파일을 다시 가져오면 모든 행이 duplicates이고 새로 기록한 행은 0이다", async () => {
    const store = makeStore();
    const lines = [header(), frag("a", "Redis 포트는 6380으로 운영한다"), frag("b", "Nginx는 3999 포트에서 받는다"), trailer({ fragments: 2, links: 0, versions: 0 })];
    const first  = await run(lines, { store });
    const second = await run(lines, { store });
    assert.equal(first.summary.imported, 2);
    assert.deepEqual([second.summary.imported, second.summary.duplicates], [0, 2]);
  });

  it("같은 id에 다른 본문이면 id_conflict로 거부하고 idempotent이면 duplicates로 센다", async () => {
    const store = makeStore();
    await run([frag("a", "Redis 포트는 6380으로 운영한다")], { store });
    const other = [frag("a", "전혀 다른 본문을 같은 id로 가져온다")];

    const strict = (await run(other, { store })).summary;
    assert.deepEqual(strict.rejected_by_reason, { id_conflict: 1 });
    assert.equal(strict.duplicates, 0);

    const lenient = (await run(other, { store, idempotent: true })).summary;
    assert.deepEqual([lenient.duplicates, lenient.rejected], [1, 0]);
  });

  it("관문이 정책 위반으로 거부한 행은 policy_violation으로 센다", async () => {
    const reject = () => { throw new SymbolicPolicyViolationError([{ rule: "demo" }]); };
    const { summary } = await run([frag("a", "Redis 포트는 6380으로 운영한다")], { steps: { policy: reject } });
    assert.deepEqual(summary.rejected_by_reason, { policy_violation: 1 });
  });

  it("거부 표본은 상한까지만 남기고 거부 건수는 모두 센다", async () => {
    const lines = Array.from({ length: MAX_REJECT_SAMPLES + 5 }, (_, i) => frag(`r${i}`, "짧음"));
    const { summary } = await run(lines);
    assert.equal(summary.rejected, MAX_REJECT_SAMPLES + 5);
    assert.equal(summary.rejected_samples.length, MAX_REJECT_SAMPLES);
  });

  it("행 문제가 아닌 실패는 failFast이면 집계를 담아 중단하고 아니면 errors로 센 뒤 계속한다", async () => {
    const lines = [frag("a", "Redis 포트는 6380으로 운영한다"), frag("b", "__db_error__"), frag("c", "Nginx는 3999 포트에서 받는다")];
    const aborted = await run(lines, { failFast: true }).catch(err => err);
    assert.ok(aborted instanceof ImportAbortedError);
    assert.equal(aborted.report.toJSON().imported, 1);

    const { summary } = await run(lines);
    assert.deepEqual([summary.imported, summary.errors], [2, 1]);
  });
});

describe("링크와 이력", () => {
  const two = [header(), frag("a", "Redis 포트는 6380으로 운영한다"), frag("b", "Nginx는 3999 포트에서 받는다")];

  it("양 끝이 처리된 링크는 imported, 다시 가져오면 duplicates다", async () => {
    const store = makeStore();
    const lines = [...two, line({ record: "link", from_id: "a", to_id: "b", relation_type: "caused_by", weight: 2 }),
                   trailer({ fragments: 2, links: 1, versions: 0 })];
    const first  = (await run(lines, { store })).summary;
    const second = (await run(lines, { store })).summary;
    assert.equal(first.links.imported, 1);
    assert.deepEqual([second.links.imported, second.links.duplicates], [0, 1]);
    assert.equal(store.links.get("a>b").weight, 2);
  });

  it("본문이 같아 기존 파편으로 대응된 끝점은 기존 id로 링크를 건다", async () => {
    const store = makeStore();
    await run([frag("existing", "Redis 포트는 6380으로 운영한다")], { store });
    await run([header(), frag("incoming", "Redis 포트는 6380으로 운영한다"), frag("b", "Nginx는 3999 포트에서 받는다"),
               line({ record: "link", from_id: "incoming", to_id: "b" })], { store });
    assert.ok(store.links.has("existing>b"), [...store.links.keys()].join(","));
  });

  it("두 끝이 같은 기존 파편으로 대응되면 자기 링크가 되므로 거부한다", async () => {
    const { summary } = await run([header(),
      frag("a", "Redis 포트는 6380으로 운영한다"),
      frag("b", "Redis 포트는 6380으로 운영한다"),
      line({ record: "link", from_id: "a", to_id: "b" })
    ]);
    assert.deepEqual(summary.rejected_by_reason, { link_invalid: 1 });
  });

  it("잘못된 링크는 유형별 사유로 거부한다", async () => {
    const { summary } = await run([...two,
      line({ record: "link", from_id: "a", to_id: "missing" }),
      line({ record: "link", from_id: "a", to_id: "a" }),
      line({ record: "link", from_id: "a", to_id: "b", relation_type: "friend_of" }),
      line({ record: "link", from_id: "a", to_id: "b", weight: "heavy" })
    ]);
    assert.deepEqual(summary.rejected_by_reason, { link_endpoint_missing: 1, link_invalid: 3 });
    assert.equal(summary.links.rejected, 4);
  });

  it("이력은 이 실행에서 새로 만든 파편에만 붙이고 본문의 민감 정보는 가린다", async () => {
    const store = makeStore();
    await run([frag("old", "이미 있던 파편의 본문이다")], { store });
    const { summary } = await run([header(),
      frag("old", "이미 있던 파편의 본문이다"),
      frag("new", "새로 만든 파편의 본문이다"),
      line({ record: "version", fragment_id: "old", content: "옛 이력 본문 내용" }),
      line({ record: "version", fragment_id: "new", content: "담당자 메일은 ops-team@example.com 이다" }),
      line({ record: "version", fragment_id: "ghost", content: "없는 파편의 이력" })
    ], { store });
    assert.deepEqual([summary.versions.imported, summary.versions.duplicates, summary.versions.rejected], [1, 1, 1]);
    assert.equal(store.versions.length, 1);
    assert.equal(store.versions[0].fragment_id, "new");
    assert.ok(!store.versions[0].content.includes("ops-team@example.com"));
  });
});

describe("끝 줄", () => {
  it("끝 줄의 수가 읽은 수와 다르면 경고하고 끝 줄이 없으면 잘린 파일일 수 있다고 경고한다", async () => {
    const mismatch = await run([header(), frag("a", "Redis 포트는 6380으로 운영한다"), trailer({ fragments: 5, links: 0, versions: 0 })]);
    assert.ok(mismatch.summary.warnings.some(w => w.code === "trailer_mismatch" && w.entity === "fragments" && w.expected === 5 && w.seen === 1));

    const missing = await run([header(), frag("a", "Redis 포트는 6380으로 운영한다")]);
    assert.ok(missing.summary.warnings.some(w => w.code === "trailer_missing"));
  });
});

describe("대상 키와 권한", () => {
  const row = { record: "fragment", id: "a", content: "Redis 포트는 6380으로 운영한다", topic: "ops", key_id: "foreign-key", is_anchor: true };

  it("기록 키는 프로필이 정하고 행의 key_id는 읽지 않으며 무시한 수를 센다", async () => {
    const store = makeStore();
    const { summary } = await run([line(row)], { store, profile: importProfile(IMPORT_DEFAULTS.admin, { keyId: "target-key", owner: true }) });
    assert.equal(store.calls[0].draft.key_id, "target-key");
    assert.equal(summary.ignored.key_id, 1);
  });

  it("owner가 아닌 프로필은 행의 is_anchor를 받지 않고 무시한 수를 센다", async () => {
    const store = makeStore();
    const { summary } = await run([line(row)], { store, profile: importProfile(IMPORT_DEFAULTS.admin, { owner: false }) });
    assert.equal(store.calls[0].draft.is_anchor, false);
    assert.equal(summary.ignored.is_anchor, 1);
  });

  it("owner 프로필은 행의 is_anchor를 따른다", async () => {
    const store = makeStore();
    const { summary } = await run([line(row)], { store });
    assert.equal(store.calls[0].draft.is_anchor, true);
    assert.equal(summary.ignored.is_anchor, 0);
  });

  it("되살리기 프로필은 owner에서만 만들 수 있다", () => {
    assert.throws(() => importProfile(IMPORT_DEFAULTS.cli, { owner: false, restore: true }), ImportOptionError);
    assert.doesNotThrow(() => importProfile(IMPORT_DEFAULTS.cli, { owner: true, restore: true }));
  });
});

describe("되살리기 모드", () => {
  const restoreProfile = importProfile(IMPORT_DEFAULTS.cli, { owner: true, restore: true });
  const longRow = { id: "long", content: LONG, topic: "ops", type: "fact", importance: 0.95, ttl_tier: "permanent", content_hash: sha(LONG) };

  it("보통 가져오기는 본문을 저장 상한으로 자르고 되살리기는 저장된 본문 그대로 기록한다", async () => {
    const normal = await run([header(), frag(longRow.id, LONG, { content_hash: longRow.content_hash })]);
    const stored = normal.store.rows.get("long").draft.content;
    assert.ok(stored.length < LONG.length);
    assert.equal(normal.summary.transformed, 1);

    const restored = await run([header(), frag(longRow.id, LONG, { content_hash: longRow.content_hash })], {
      profile: restoreProfile, steps: RESTORE_STEPS
    });
    assert.equal(sha(restored.store.rows.get("long").draft.content), longRow.content_hash);
    assert.equal(restored.summary.transformed, 0);
  });

  it("되살리기는 importance 상한을 적용하지 않고 ttl_tier를 유지하며 보통 가져오기는 warm으로 둔다", async () => {
    const restored = await run([header(), frag("long", LONG, { importance: 0.95, ttl_tier: "permanent" })], {
      profile: restoreProfile, steps: RESTORE_STEPS
    });
    assert.equal(restored.store.calls[0].opts.exactImportance, true);
    assert.equal(restored.store.calls[0].draft.ttl_tier, "permanent");

    const normal = await run([header(), frag("long", LONG, { importance: 0.95, ttl_tier: "permanent" })]);
    assert.equal(normal.store.calls[0].opts.exactImportance, false);
    assert.equal(normal.store.calls[0].draft.ttl_tier, "warm");
  });

  it("되살리기는 최소 품질 검사를 건너뛰되 민감 정보 마스킹은 적용한다", async () => {
    const restored = await run([header(),
      frag("short", "ok"),
      frag("mail", "담당자 메일은 ops-team@example.com 이다")
    ], { profile: restoreProfile, steps: RESTORE_STEPS });
    assert.equal(restored.summary.imported, 2);
    assert.ok(!restored.store.rows.get("mail").draft.content.includes("ops-team@example.com"));
  });

  it("되살리기는 머리 줄이 없는 버전 1 파일을 받지 않는다", async () => {
    await assert.rejects(
      run([line({ id: "a", content: "Redis 포트는 6380으로 운영한다", topic: "ops" })], { profile: restoreProfile, steps: RESTORE_STEPS }),
      ImportOptionError
    );
  });
});

describe("dryRun", () => {
  it("같은 입력의 집계가 실제 실행과 같고 트랜잭션을 되돌린다", async () => {
    const lines = [header(), frag("a", "Redis 포트는 6380으로 운영한다"), frag("b", "Redis 포트는 6380으로 운영한다"), frag("c", "짧음"),
                   line({ record: "link", from_id: "a", to_id: "b" }), trailer({ fragments: 3, links: 1, versions: 0 })];
    const real = await run(lines);
    const dry  = await run(lines, { dryRun: true });
    const strip = ({ dryRun: _d, ...rest }) => rest;
    assert.deepEqual(strip(dry.summary), strip(real.summary));
    assert.equal(dry.summary.dryRun, true);
    assert.equal(dry.db.statements[0], "BEGIN");
    assert.equal(dry.db.statements.at(-1), "ROLLBACK");
    assert.ok(!dry.db.statements.includes("COMMIT"));
  });

  it("관문에서 모두 거부된 입력은 DB 연결을 열지 않는다", async () => {
    const db = makeDb();
    db.pool.connect = async () => { throw new Error("must not connect"); };
    const { summary } = await run([frag("a", "짧음")], { dryRun: true, db });
    assert.equal(summary.rejected, 1);
  });

  it("dryRun은 임베딩 큐에 올리지 않는다", async () => {
    let queued = 0;
    await run([frag("a", "Redis 포트는 6380으로 운영한다")], { dryRun: true, onCreated: async (ids) => { queued += ids.length; return ids.length; } });
    assert.equal(queued, 0);
  });
});

describe("임베딩 큐", () => {
  it("새로 만든 파편 id만 묶음으로 올리고 올린 수를 응답에 싣는다", async () => {
    const batches = [];
    const lines   = Array.from({ length: 120 }, (_, i) => frag(`n${i}`, `서로 다른 본문 번호 ${i} 를 기록한다`));
    lines.push(frag("dup", "서로 다른 본문 번호 3 를 기록한다"));
    const { summary } = await run(lines, { onCreated: async (ids) => { batches.push(ids); return ids.length - 1; } });
    assert.equal(summary.imported, 120);
    assert.equal(summary.duplicates, 1);
    assert.ok(batches.length >= 2);
    assert.equal(batches.flat().length, 120);
    assert.equal(summary.embedding_queued, 120 - batches.length);
  });
});
