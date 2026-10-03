/**
 * AuditStore 시험(가짜 풀)
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 체인 기록의 잠금과 순번, 멱등, 조회 조건 판독, 묶음 검증의 기준점, 보존 정리 인자를 가짜 풀로 본다.
 * SQL 실행 결과는 tests/db-concurrency/audit-events.test.js가 실서버에서 본다.
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";

import { AuditStore, AuditQueryError, parseAuditFilters, auditWhereClause, AUDIT_LIST_LIMIT_MAX } from "../../lib/logging/AuditStore.js";
import { GENESIS_HASH, computeRowHash } from "../../lib/logging/audit-chain.js";

const RECORD = Object.freeze({
  occurredAt  : "2026-10-03T00:00:00.000Z",
  action      : "admin.key.policy_update",
  outcome     : "success",
  actorKind   : "master",
  actorKeyId  : null,
  actorSession: "c1234567",
  actorIp     : "127.0.0.1",
  targetType  : "api_key",
  targetId    : "6f1c0f7e",
  workspace   : null,
  detail      : { status: 200 }
});

/**
 * 질의 문장별 응답을 주는 가짜 풀. 연결 하나를 빌려 주고 트랜잭션 문장을 기록한다.
 *
 * @param {(sql: string, params: unknown[]) => { rows: object[], rowCount?: number }|undefined} respond
 */
function fakePool(respond) {
  const calls  = [];
  const client = {
    query  : async (sql, params = []) => {
      calls.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
      return respond(sql, params) ?? { rows: [], rowCount: 0 };
    },
    release: () => { calls.push({ sql: "RELEASE", params: [] }); }
  };
  return { calls, pool: { connect: async () => client, query: client.query } };
}

describe("체인 기록", () => {
  it("빈 표의 첫 행은 seq 1과 GENESIS_HASH로 기록한다", async () => {
    const { calls, pool } = fakePool(() => undefined);
    const store  = new AuditStore(pool, { clock: () => Date.parse("2026-10-03T00:00:01.000Z") });
    const result = await store.append(RECORD, "audit.record:7");

    const expected = computeRowHash(GENESIS_HASH, { ...RECORD, seq: 1, sourceEvent: "audit.record:7", recordedAt: "2026-10-03T00:00:01.000Z" });
    assert.deepEqual(result, { seq: 1, rowHash: expected, duplicate: false });

    const sqls = calls.map(c => c.sql);
    assert.equal(sqls[0], "BEGIN");
    assert.match(sqls[1], /SET LOCAL lock_timeout/);
    assert.match(sqls[2], /^LOCK TABLE \S+admin_audit_events IN SHARE ROW EXCLUSIVE MODE$/);
    assert.match(sqls[3], /WHERE source_event = \$1/);
    assert.match(sqls[4], /ORDER BY seq DESC LIMIT 1/);
    assert.match(sqls[5], /^INSERT INTO \S+admin_audit_events/);
    assert.equal(sqls[6], "COMMIT");
    const insert = calls[5].params;
    assert.equal(insert[0], 1);
    assert.equal(insert[1], "audit.record:7");
    assert.equal(insert.at(-2), GENESIS_HASH);
    assert.equal(insert.at(-1), expected);
  });

  it("다음 행은 마지막 행의 seq + 1과 row_hash를 잇고 기록 시각이 앞 행보다 이르지 않다", async () => {
    const lastHash = "e".repeat(64);
    const { calls, pool } = fakePool((sql) => (/ORDER BY seq DESC LIMIT 1/.test(sql)
      ? { rows: [{ seq: "41", row_hash: lastHash, recorded_at: new Date("2026-10-03T00:00:05.000Z") }] }
      : undefined));
    const store  = new AuditStore(pool, { clock: () => Date.parse("2026-10-03T00:00:01.000Z") });
    const result = await store.append(RECORD, "audit.record:8");

    const row = { ...RECORD, seq: 42, sourceEvent: "audit.record:8", recordedAt: "2026-10-03T00:00:05.000Z" };
    assert.deepEqual(result, { seq: 42, rowHash: computeRowHash(lastHash, row), duplicate: false });
    const insert = calls.find(c => c.sql.startsWith("INSERT")).params;
    assert.equal(insert[0], 42);
    assert.equal(insert.at(-2), lastHash);
  });

  it("같은 source_event가 이미 있으면 새 행 없이 기존 행을 돌려준다", async () => {
    const { calls, pool } = fakePool((sql) => (/WHERE source_event = \$1/.test(sql)
      ? { rows: [{ seq: "5", row_hash: "a".repeat(64) }] }
      : undefined));
    const result = await new AuditStore(pool).append(RECORD, "audit.record:9");
    assert.deepEqual(result, { seq: 5, rowHash: "a".repeat(64), duplicate: true });
    assert.equal(calls.some(c => c.sql.startsWith("INSERT")), false);
    assert.equal(calls.some(c => c.sql === "COMMIT"), true);
  });

  it("기록이 실패하면 롤백하고 오류를 그대로 던진다", async () => {
    const { calls, pool } = fakePool((sql) => {
      if (sql.startsWith("INSERT") || /INSERT/.test(sql.trim().slice(0, 20))) throw new Error("insert failed");
      return undefined;
    });
    await assert.rejects(new AuditStore(pool).append(RECORD, "audit.record:10"), /insert failed/);
    assert.equal(calls.some(c => c.sql === "ROLLBACK"), true);
    assert.equal(calls.at(-1).sql, "RELEASE");
  });
});

describe("조회 조건", () => {
  const params = (q) => new URLSearchParams(q);

  it("행위 이름은 정확히 같거나 '.*'로 끝나면 접두어로 찾는다", () => {
    assert.deepEqual(auditWhereClause(parseAuditFilters(params("action=admin.key.policy_update"))),
      { sql: "action = $1", params: ["admin.key.policy_update"] });
    assert.deepEqual(auditWhereClause(parseAuditFilters(params("action=admin.*"))),
      { sql: "action LIKE $1", params: ["admin.%"] });
  });

  it("행위자는 master, anonymous, system이면 종류로, 키 id면 키로 찾는다", () => {
    assert.deepEqual(auditWhereClause(parseAuditFilters(params("actor=master"))), { sql: "actor_kind = $1", params: ["master"] });
    const key = "6f1c0f7e-1111-4000-8000-000000000001";
    assert.deepEqual(auditWhereClause(parseAuditFilters(params(`actor=${key}`))), { sql: "actor_key_id = $1", params: [key] });
  });

  it("대상, 결과, workspace, 기간, 커서를 함께 쓴다", () => {
    const filters = parseAuditFilters(params(
      "target_type=fragment&target_id=f-1&outcome=denied&workspace=w&from=2026-10-01T00:00:00Z&to=2026-10-02T00:00:00Z&before=90"));
    const where   = auditWhereClause(filters);
    assert.equal(where.sql, "target_type = $1 AND target_id = $2 AND outcome = $3 AND workspace = $4 AND occurred_at >= $5 AND occurred_at < $6 AND seq < $7");
    assert.deepEqual(where.params.slice(0, 4), ["fragment", "f-1", "denied", "w"]);
    assert.equal(where.params[6], 90);
  });

  it("조건이 없으면 TRUE다", () => {
    assert.deepEqual(auditWhereClause(parseAuditFilters(params(""))), { sql: "TRUE", params: [] });
  });

  it("limit은 기본 50, 상한까지다", () => {
    assert.equal(parseAuditFilters(params("")).limit, 50);
    assert.equal(parseAuditFilters(params(`limit=${AUDIT_LIST_LIMIT_MAX}`)).limit, AUDIT_LIST_LIMIT_MAX);
  });

  it("형식이 틀린 값은 필드와 함께 거부한다", () => {
    for (const [q, field] of [
      ["action=Admin;DROP", "action"], ["outcome=ok", "outcome"], ["actor=x y", "actor"], ["from=어제", "from"],
      ["before=-1", "before"], ["limit=0", "limit"], [`limit=${AUDIT_LIST_LIMIT_MAX + 1}`, "limit"], ["target_type=A B", "target_type"]
    ]) {
      assert.throws(() => parseAuditFilters(params(q)), (e) => e instanceof AuditQueryError && e.field === field, q);
    }
  });
});

describe("목록과 검증", () => {
  /** seq 1부터 이어진 행(DB 열 이름) */
  function dbChain(n, start = 1, prev = GENESIS_HASH) {
    const rows = [];
    for (let i = 0; i < n; i++) {
      const seq    = start + i;
      const record = { ...RECORD, seq, sourceEvent: `audit.record:${seq}`, recordedAt: new Date(Date.UTC(2026, 9, 3, 0, 0, seq)) };
      const hash   = computeRowHash(prev, record);
      rows.push({
        seq: String(seq), source_event: record.sourceEvent, occurred_at: new Date(record.occurredAt), recorded_at: record.recordedAt,
        action: record.action, outcome: record.outcome, actor_kind: record.actorKind, actor_key_id: null,
        actor_session: record.actorSession, actor_ip: record.actorIp, target_type: record.targetType, target_id: record.targetId,
        workspace: null, detail: { status: 200 }, prev_hash: prev, row_hash: hash
      });
      prev = hash;
    }
    return rows;
  }

  /** 검증 질의(seq > $1 ORDER BY seq LIMIT $2)에 응답하는 가짜 풀 */
  function chainPool(rows) {
    return fakePool((sql, p) => {
      if (/min\(seq\)/i.test(sql)) return { rows: [{ min: rows[0]?.seq ?? null }] };
      if (/WHERE seq = \$1/.test(sql)) return { rows: rows.filter(r => Number(r.seq) === p[0]) };
      if (/seq > \$1/.test(sql)) return { rows: rows.filter(r => Number(r.seq) > p[0]).slice(0, p[1]) };
      return undefined;
    });
  }

  it("목록은 최근 순으로 돌려주고 다음 커서를 준다", async () => {
    const rows = dbChain(3).reverse();
    const { pool } = fakePool((sql) => (/ORDER BY seq DESC LIMIT/.test(sql) ? { rows } : undefined));
    const page = await new AuditStore(pool).list(parseAuditFilters(new URLSearchParams("limit=3")));
    assert.deepEqual(page.events.map(e => e.seq), [3, 2, 1]);
    assert.equal(page.nextBefore, 1);
    assert.equal(page.events[0].actorKind, "master");
    assert.equal(page.events[0].occurredAt, RECORD.occurredAt);
  });

  it("마지막 쪽은 다음 커서가 null이다", async () => {
    const rows = dbChain(2).reverse();
    const { pool } = fakePool((sql) => (/ORDER BY seq DESC LIMIT/.test(sql) ? { rows } : undefined));
    const page = await new AuditStore(pool).list(parseAuditFilters(new URLSearchParams("limit=5")));
    assert.equal(page.nextBefore, null);
  });

  it("seq 1부터 온전한 체인은 genesis 기준점으로 끝까지 확인한다", async () => {
    const { pool } = chainPool(dbChain(5));
    const result = await new AuditStore(pool).verify({ chunk: 2 });
    assert.equal(result.ok, true);
    assert.equal(result.checked, 5);
    assert.equal(result.anchor, "genesis");
    assert.equal(result.complete, true);
    assert.equal(result.headHash, dbChain(5)[4].row_hash);
  });

  it("seq 1의 prev_hash가 GENESIS_HASH가 아니면 끊김이다", async () => {
    const rows = dbChain(2, 1, "1".repeat(64));
    const { pool } = chainPool(rows);
    const result = await new AuditStore(pool).verify({});
    assert.equal(result.ok, false);
    assert.deepEqual(result.broken, { seq: 1, reason: "prev_hash_mismatch" });
  });

  it("앞부분이 정리된 체인은 남은 첫 행을 기준점으로 삼는다", async () => {
    const full = dbChain(6);
    const { pool } = chainPool(full.slice(2));
    const result = await new AuditStore(pool).verify({});
    assert.equal(result.ok, true);
    assert.equal(result.anchor, "retained");
    assert.equal(result.firstSeq, 3);
    assert.equal(result.anchorHash, full[1].row_hash);
  });

  it("fromSeq를 주면 바로 앞 행의 row_hash에 이어지는지 본다", async () => {
    const full = dbChain(6);
    full[3]    = { ...full[3], prev_hash: "9".repeat(64) };
    const { pool } = chainPool(full);
    const result = await new AuditStore(pool).verify({ fromSeq: 4 });
    assert.equal(result.anchor, "previous_row");
    assert.deepEqual(result.broken, { seq: 4, reason: "prev_hash_mismatch" });
  });

  it("maxRows에서 멈추면 complete가 false다", async () => {
    const { pool } = chainPool(dbChain(5));
    const result = await new AuditStore(pool).verify({ maxRows: 3, chunk: 2 });
    assert.equal(result.ok, true);
    assert.equal(result.checked, 3);
    assert.equal(result.complete, false);
  });

  it("값이 바뀐 행을 끊김으로 보고한다", async () => {
    const rows = dbChain(4);
    rows[2]    = { ...rows[2], outcome: "denied" };
    const { pool } = chainPool(rows);
    const result = await new AuditStore(pool).verify({});
    assert.deepEqual(result.broken, { seq: 3, reason: "row_hash_mismatch" });
    assert.equal(result.checked, 2);
  });

  it("빈 표는 확인할 행이 없고 끊김이 없다", async () => {
    const { pool } = chainPool([]);
    const result = await new AuditStore(pool).verify({});
    assert.equal(result.ok, true);
    assert.equal(result.checked, 0);
    assert.equal(result.anchor, null);
  });
});

describe("보존 정리", () => {
  it("보존 일수와 묶음 상한을 넘기고 지운 행 수를 돌려준다", async () => {
    const { calls, pool } = fakePool((sql) => (/^\s*WITH|DELETE/.test(sql) ? { rows: [], rowCount: 7 } : undefined));
    const deleted = await new AuditStore(pool).cleanup({ retentionDays: 400, limit: 500 });
    assert.equal(deleted, 7);
    const del = calls.find(c => /DELETE FROM/.test(c.sql));
    assert.deepEqual(del.params, [400, 500]);
    assert.match(del.sql, /seq < \(SELECT max\(seq\)/);
  });
});
