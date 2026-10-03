/**
 * finish-dedup-scope.mjs 계획과 실행 논리 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 인자 처리, 단계 계획, 색인 상태 판정과, 연결 대역으로 실행 흐름(새 색인이 유효하지 않으면 거부,
 * 55P03 재시도, 제거 확인, 재시도 소진)을 확인한다. DB는 쓰지 않는다.
 */
import { describe, it } from "node:test";
import assert           from "node:assert/strict";

import {
  NEW_INDEXES, OLD_INDEXES, STATE_SQL, EXISTS_SQL,
  parseFinishArgs, planFinish, evaluateState, dropOldSql, main
} from "../../scripts/ops/finish-dedup-scope.mjs";
import { DEDUP_INDEXES } from "../../lib/memory/write/DedupScope.js";
import { OPEN_TXN_SQL }  from "../../scripts/ops/online-index-plan.mjs";

const URL_ARGS = ["--url", "postgresql://u:secret-pw@db.example:5432/memento"];

/**
 * 연결 대역. indexes는 이름별 { valid, ready }이고, dropFailures는 이름별로 앞선 몇 번의 DROP이
 * 55P03으로 실패할지 정한다. 실패한 DROP은 색인을 무효 상태로 남긴다.
 */
function fakeClient({ indexes, dropFailures = {}, openCount = 0 }) {
  const state = new Map(Object.entries(indexes));
  const calls = [];
  const fails = { ...dropFailures };
  return {
    calls,
    state,
    ended: false,
    async query(sql, params) {
      calls.push(sql);
      if (sql === STATE_SQL) {
        return { rows: [...state.entries()].filter(([n]) => params[1].includes(n)).map(([name, s]) => ({ name, ...s })) };
      }
      if (sql === EXISTS_SQL) return { rows: [...state.keys()].filter(n => params[1].includes(n)).map(name => ({ name })) };
      if (sql === OPEN_TXN_SQL) return { rows: [{ open_count: openCount, oldest_seconds: openCount ? 5 : 0 }] };
      const drop = /^DROP INDEX CONCURRENTLY IF EXISTS agent_memory\.(\w+)$/.exec(sql);
      if (drop) {
        const name = drop[1];
        if ((fails[name] ?? 0) > 0) {
          fails[name]--;
          if (state.has(name)) state.set(name, { valid: false, ready: true });
          throw Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" });
        }
        state.delete(name);
        return { rows: [] };
      }
      return { rows: [] };
    },
    async end() { this.ended = true; }
  };
}

function capture() {
  const out = [];
  const err = [];
  return { out, err, deps: { out: l => out.push(l), err: l => err.push(l) } };
}

const ALL_VALID = Object.fromEntries([...NEW_INDEXES, ...OLD_INDEXES].map(n => [n, { valid: true, ready: true }]));

describe("이름과 인자", () => {
  it("색인 이름은 앱의 판정 색인 이름과 같다", () => {
    assert.deepEqual([...NEW_INDEXES], [DEDUP_INDEXES.keyScoped, DEDUP_INDEXES.masterScoped]);
    assert.deepEqual([...OLD_INDEXES], [DEDUP_INDEXES.keyLegacy, DEDUP_INDEXES.masterLegacy]);
  });

  it("online-index 전용 옵션은 거부한다", () => {
    for (const argv of [["--index", "x"], ["--free-bytes", "1"], ["--data-dir", "/tmp"], ["--manifest", "m.json"]]) {
      assert.throws(() => parseFinishArgs(argv), { name: "OnlineIndexUsageError" });
    }
    assert.equal(parseFinishArgs(["--confirm", "--retries", "3"]).retries, 3);
  });
});

describe("단계 계획과 상태 판정", () => {
  it("확인, 새 색인 요구, 제거, 제거 확인 순이고 제거는 CONCURRENTLY IF EXISTS다", () => {
    const steps = planFinish({ lockTimeout: "3s", retries: 2, targetLabel: "t" });
    const ids   = steps.map(s => s.id);
    assert.ok(ids.indexOf("inspect") < ids.indexOf("require-new"));
    assert.ok(ids.indexOf("require-new") < ids.indexOf("drop"));
    assert.equal(ids.at(-1), "verify");
    assert.deepEqual(steps.filter(s => s.id === "drop").map(s => s.sql[0]), OLD_INDEXES.map(dropOldSql));
    assert.equal(dropOldSql("uq_frag_hash_master"), "DROP INDEX CONCURRENTLY IF EXISTS agent_memory.uq_frag_hash_master");
  });

  it("새 색인 둘이 유효해야 하고 무효 상태의 옛 색인도 남은 것으로 본다", () => {
    const ok = evaluateState([...NEW_INDEXES.map(name => ({ name, valid: true, ready: true })), { name: OLD_INDEXES[0], valid: false, ready: true }]);
    assert.equal(ok.newValid, true);
    assert.deepEqual(ok.oldPresent, [OLD_INDEXES[0]]);
    const bad = evaluateState([{ name: NEW_INDEXES[0], valid: true, ready: true }, { name: NEW_INDEXES[1], valid: false, ready: true }]);
    assert.equal(bad.newValid, false);
    assert.deepEqual(bad.missingNew, [NEW_INDEXES[1]]);
  });
});

describe("실행", () => {
  it("--confirm 이 없으면 연결하지 않고 단계만 출력한다", async () => {
    const { out, deps } = capture();
    const code = await main([], {}, { ...deps, connect: async () => { throw new Error("연결하면 안 된다"); } });
    assert.equal(code, 0);
    assert.ok(out.some(l => l.includes(dropOldSql(OLD_INDEXES[0]))));
  });

  it("대상이 없으면 거부한다(종료 코드 2)", async () => {
    const { err, deps } = capture();
    assert.equal(await main(["--confirm"], {}, deps), 2);
    assert.ok(err.some(l => l.includes("거부")));
  });

  it("새 색인이 유효하지 않으면 아무것도 지우지 않고 실패한다", async () => {
    const client = fakeClient({ indexes: { ...ALL_VALID, [NEW_INDEXES[1]]: { valid: false, ready: true } } });
    const { err, deps } = capture();
    const code = await main(["--confirm", ...URL_ARGS], {}, { ...deps, connect: async () => client });
    assert.equal(code, 1);
    assert.equal(client.calls.some(s => s.startsWith("DROP")), false);
    assert.ok(err.some(l => l.includes(NEW_INDEXES[1])));
    assert.equal(client.ended, true);
  });

  it("55P03 은 대기 뒤 다시 시도하고 옛 색인이 사라졌는지 확인한다", async () => {
    const client = fakeClient({ indexes: ALL_VALID, dropFailures: { [OLD_INDEXES[0]]: 2 } });
    const waits  = [];
    const { out, deps } = capture();
    const code = await main(["--confirm", ...URL_ARGS, "--retry-wait-ms", "10"], {},
      { ...deps, connect: async () => client, sleep: async ms => { waits.push(ms); } });
    assert.equal(code, 0);
    assert.deepEqual(waits, [10, 20]);
    assert.deepEqual([...client.state.keys()].sort(), [...NEW_INDEXES].sort());
    assert.ok(client.calls.includes(EXISTS_SQL));
    assert.ok(out.some(l => l.includes("완료")));
    assert.equal(out.join("\n").includes("secret-pw"), false);
  });

  it("무효 상태로 남은 옛 색인도 지운다(중단 뒤 다시 실행)", async () => {
    const client = fakeClient({ indexes: { ...ALL_VALID, [OLD_INDEXES[0]]: { valid: false, ready: true }, [OLD_INDEXES[1]]: { valid: false, ready: true } } });
    const { deps } = capture();
    assert.equal(await main(["--confirm", ...URL_ARGS], {}, { ...deps, connect: async () => client }), 0);
    assert.equal(OLD_INDEXES.some(n => client.state.has(n)), false);
  });

  it("재시도를 모두 쓰면 실패로 끝나고 상태를 알린다", async () => {
    const client = fakeClient({ indexes: ALL_VALID, dropFailures: { [OLD_INDEXES[0]]: 5 }, openCount: 1 });
    const { out, err, deps } = capture();
    const code = await main(["--confirm", ...URL_ARGS, "--retries", "1", "--retry-wait-ms", "0"], {},
      { ...deps, connect: async () => client, sleep: async () => {} });
    assert.equal(code, 1);
    assert.ok(err.some(l => l.includes("무효 상태로 남았을 수 있으며")));
    assert.ok(out.some(l => l.includes("경고: 열려 있는 트랜잭션 1개")));
    assert.deepEqual(client.state.get(OLD_INDEXES[0]), { valid: false, ready: true });
  });

  it("옛 색인이 이미 없으면 지우지 않고 성공한다", async () => {
    const client = fakeClient({ indexes: Object.fromEntries(NEW_INDEXES.map(n => [n, { valid: true, ready: true }])) });
    const { deps } = capture();
    assert.equal(await main(["--confirm", ...URL_ARGS], {}, { ...deps, connect: async () => client }), 0);
    assert.equal(client.calls.some(s => s.startsWith("DROP")), false);
  });
});
