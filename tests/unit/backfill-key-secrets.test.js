/**
 * 키 비밀 이관 스크립트 시험(연결 대체)
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 순수 함수 시험과 연결 대체 시험: 대상이 명시되지 않으면 연결하지 않고 거부한다. 기본(--confirm 없음)은
 * 읽기 전용 트랜잭션에서 건수와 정합만 보고 쓰지 않는다. --confirm은 일괄 insert-select를 0건이 될 때까지
 * 반복한 뒤 정합을 확인하고, 정합이 맞지 않으면 실패 코드다.
 */
import { describe, it } from "node:test";
import assert           from "node:assert/strict";

import {
  main, consistencyVerdict, BACKFILL_SQL, BACKFILL_BATCH
} from "../../scripts/ops/backfill-key-secrets.mjs";

const consistentRow = { keys_total: 3, keys_with_secret: 3, active_keys: 2, active_keys_with_active_secret: 2, active_secret_rows: 3, overlap_secret_rows: 1 };

/** 질의를 기록하고 정해 둔 응답을 돌려주는 연결 */
function fakeClient({ missing = 2, tableExists = true, after = consistentRow } = {}) {
  const sqls = [];
  let   left = missing;
  return {
    sqls,
    async query(sql, params = []) {
      sqls.push({ sql: sql.trim(), params });
      if (/to_regclass/.test(sql))           return { rows: [{ present: tableExists }] };
      if (/AS missing/.test(sql))            return { rows: [{ missing: left }] };
      if (sql === BACKFILL_SQL) {
        const n = Math.min(left, params[0]);
        left   -= n;
        return { rows: [], rowCount: n };
      }
      if (/AS keys_total/.test(sql))         return { rows: [left === 0 ? after : { ...after, keys_with_secret: after.keys_total - left }] };
      return { rows: [], rowCount: 0 };
    },
    async end() {}
  };
}

function run(argv, env, client) {
  const out = [];
  const err = [];
  return main(argv, env, { connect: async () => client, out: (l) => out.push(l), err: (l) => err.push(l) })
    .then((code) => ({ code, out: out.join("\n"), err: err.join("\n") }));
}

describe("정합 판정", () => {
  it("모든 키에 현재 해시 행이 있고 활성 키 수와 활성 현재 비밀 수가 같으면 정합이다", () => {
    assert.deepEqual(consistencyVerdict(consistentRow), { consistent: true, problems: [] });
  });

  it("비밀 행이 없는 키, 활성 비밀이 없는 활성 키를 문제로 보고한다", () => {
    const verdict = consistencyVerdict({ ...consistentRow, keys_with_secret: 2, active_keys_with_active_secret: 1 });
    assert.equal(verdict.consistent, false);
    assert.equal(verdict.problems.length, 2);
  });
});

describe("실행 모드", () => {
  it("대상이 없으면 연결하지 않고 거부한다", async () => {
    let connected = false;
    const r = await main([], {}, { connect: async () => { connected = true; }, out: () => {}, err: () => {} });
    assert.equal(r, 2);
    assert.equal(connected, false);
  });

  it("기본은 읽기 전용으로 건수와 정합만 보고 쓰지 않는다", async () => {
    const client = fakeClient();
    const r = await run(["--url", "postgresql://u@db.invalid/mem"], {}, client);
    assert.equal(r.code, 0);
    assert.ok(client.sqls.some((q) => /^BEGIN READ ONLY/.test(q.sql)));
    assert.ok(!client.sqls.some((q) => q.sql === BACKFILL_SQL), "기본 모드는 쓰지 않는다");
    assert.match(r.out, /옮길 키 2건/);
  });

  it("--confirm은 0건이 될 때까지 일괄로 옮기고 정합을 확인한다", async () => {
    const client = fakeClient({ missing: BACKFILL_BATCH + 7 });
    const r = await run(["--confirm", "--url", "postgresql://u@db.invalid/mem"], {}, client);
    assert.equal(r.code, 0, r.err);
    const batches = client.sqls.filter((q) => q.sql === BACKFILL_SQL);
    assert.equal(batches.length, 3, "500, 7, 0");
    assert.match(r.out, /정합: 일치/);
  });

  it("다시 실행하면 옮길 행이 없어 쓰지 않고 정합만 확인한다(멱등)", async () => {
    const client = fakeClient({ missing: 0 });
    const r = await run(["--confirm", "--url", "postgresql://u@db.invalid/mem"], {}, client);
    assert.equal(r.code, 0);
    assert.equal(client.sqls.filter((q) => q.sql === BACKFILL_SQL).length, 1);
  });

  it("정합이 맞지 않으면 실패 코드다", async () => {
    const client = fakeClient({ missing: 0, after: { ...consistentRow, active_keys_with_active_secret: 1 } });
    const r = await run(["--confirm", "--url", "postgresql://u@db.invalid/mem"], {}, client);
    assert.equal(r.code, 1);
    assert.match(r.err, /정합/);
  });

  it("비밀 표가 없으면 실패하고 쓰지 않는다", async () => {
    const client = fakeClient({ tableExists: false });
    const r = await run(["--confirm", "--url", "postgresql://u@db.invalid/mem"], {}, client);
    assert.equal(r.code, 1);
    assert.match(r.err, /migration-059/);
    assert.ok(!client.sqls.some((q) => q.sql === BACKFILL_SQL));
  });

  it("이 스크립트가 쓰지 않는 옵션은 거부한다", async () => {
    const r = await run(["--index", "x", "--url", "postgresql://u@db.invalid/mem"], {}, fakeClient());
    assert.equal(r.code, 2);
  });
});
