/**
 * 쓰기 트랜잭션 안 키별 앵커 상한 판정 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 연결 대역으로 잠금 문장, 재계산, 생성 후보와 갱신 열과 일괄 저장 항목의 처리, 자체 트랜잭션의
 * 커밋과 되돌림을 확인하고, 일괄 저장 처리기가 같은 트랜잭션 안에서 상한을 적용하는지 본다. DB는 쓰지 않는다.
 */

import { describe, it, mock, after } from "node:test";
import assert                         from "node:assert/strict";

/** 자체 트랜잭션 경로가 쓰는 풀 */
const ownPool = { client: null, connect: async () => ownPool.client };
mock.module("../../lib/tools/db.js", {
  namedExports: {
    getPrimaryPool      : () => ownPool,
    getBatchPool        : () => null,
    queryWithAgentVector: async () => ({ rows: [] }),
    shutdownPool        : async () => {}
  }
});

const {
  ANCHOR_QUOTA_LOCK_SQL,
  attachAnchorQuota,
  anchorQuotaOf,
  insertWithAnchorQuota,
  applyAnchorQuotaToUpdate,
  applyAnchorQuotaToBatch
} = await import("../../lib/memory/write/anchorQuota.js");
const { BatchRememberProcessor } = await import("../../lib/memory/write/BatchRememberProcessor.js");
const { FragmentFactory }        = await import("../../lib/memory/write/FragmentFactory.js");
const { WriteGate }              = await import("../../lib/memory/write/WriteGate.js");
const { teardownTestResources }  = await import("../_lifecycle.js");

after(async () => { await teardownTestResources(); });

const KEY = "0a0a0a0a-1111-4222-8333-444444444444";

/** 연결 대역. anchors는 키의 살아 있는 앵커 수다. */
function fakeClient(anchors) {
  const calls = [];
  return {
    calls,
    released: false,
    async query(sql, params) {
      calls.push({ sql: String(sql).trim(), params });
      if (/COUNT\(\*\)::int AS count FROM .*fragments/.test(sql)) return { rows: [{ count: anchors }] };
      return { rows: [] };
    },
    release() { this.released = true; }
  };
}

/** 상한 표식 대역. mode가 enforce이면 exceed가 던진다. */
function quotaOf(limit, mode = "warn") {
  const calls = [];
  return {
    calls,
    keyId : KEY,
    limit,
    exceed: () => {
      calls.push("exceed");
      if (mode === "enforce") throw new Error("policy_violation: anchorLimitExceeded");
      return { rule: "anchorLimitExceeded", severity: "medium" };
    }
  };
}

describe("표식", () => {
  it("단 값에서만 표식을 읽는다", () => {
    const value = attachAnchorQuota({}, quotaOf(3));
    assert.equal(anchorQuotaOf(value).limit, 3);
    assert.equal(anchorQuotaOf({ ...value }), null);
    assert.equal(anchorQuotaOf(null), null);
  });
});

describe("insertWithAnchorQuota", () => {
  it("호출자 트랜잭션에서 키 잠금 뒤 다시 세고 상한 아래면 그대로 기록한다", async () => {
    const client   = fakeClient(2);
    const fragment = { id: "f1", is_anchor: true };
    const quota    = quotaOf(3);
    const out      = await insertWithAnchorQuota(client, fragment, quota, async (c) => (c === client ? "written" : "wrong"));
    assert.equal(out, "written");
    assert.equal(fragment.is_anchor, true);
    assert.deepEqual(quota.calls, []);
    assert.equal(client.calls[0].sql, ANCHOR_QUOTA_LOCK_SQL);
    assert.deepEqual(client.calls[0].params, [KEY]);
    assert.match(ANCHOR_QUOTA_LOCK_SQL, /FROM agent_memory\.api_keys WHERE id = \$1 FOR NO KEY UPDATE/);
    assert.doesNotMatch(ANCHOR_QUOTA_LOCK_SQL, /advisory/);
  });

  it("상한에 이르렀으면 앵커 지정을 거두고 위반을 후보에 싣는다", async () => {
    const fragment = { id: "f1", is_anchor: true, validation_warnings: [{ rule: "decisionHasRationale" }] };
    const quota    = quotaOf(3);
    await insertWithAnchorQuota(fakeClient(3), fragment, quota, async () => "written");
    assert.equal(fragment.is_anchor, false);
    assert.deepEqual(fragment.validation_warnings.map(v => v.rule), ["decisionHasRationale", "anchorLimitExceeded"]);
    assert.deepEqual(quota.calls, ["exceed"]);
  });

  it("호출자 트랜잭션이 없으면 자체 트랜잭션에서 잠금, 재계산, 기록을 하고 커밋한다", async () => {
    ownPool.client = fakeClient(0);
    const fragment = { id: "f1", is_anchor: true };
    await insertWithAnchorQuota(undefined, fragment, quotaOf(3), async (c) => c.query("INSERT INTO agent_memory.fragments"));
    const sqls = ownPool.client.calls.map(c => c.sql);
    assert.ok(sqls.indexOf("BEGIN") < sqls.indexOf(ANCHOR_QUOTA_LOCK_SQL));
    assert.ok(sqls.indexOf(ANCHOR_QUOTA_LOCK_SQL) < sqls.findIndex(s => s.startsWith("INSERT")));
    assert.equal(sqls.at(-1), "COMMIT");
    assert.equal(ownPool.client.released, true);
  });

  it("enforce의 거부는 자체 트랜잭션을 되돌리고 기록하지 않는다", async () => {
    ownPool.client = fakeClient(3);
    let wrote = false;
    await assert.rejects(
      () => insertWithAnchorQuota(undefined, { id: "f1", is_anchor: true }, quotaOf(3, "enforce"), async () => { wrote = true; }),
      /anchorLimitExceeded/
    );
    assert.equal(wrote, false);
    assert.equal(ownPool.client.calls.at(-1).sql, "ROLLBACK");
  });
});

describe("applyAnchorQuotaToUpdate", () => {
  it("상한 아래면 같은 갱신 열을 돌려준다", async () => {
    const updates = attachAnchorQuota(Object.freeze({ is_anchor: true, topic: "t" }), quotaOf(3));
    assert.equal(await applyAnchorQuotaToUpdate(fakeClient(1), updates, { is_anchor: false }), updates);
  });

  it("상한에 이르렀으면 is_anchor만 뺀 갱신 열을 돌려준다", async () => {
    const quota   = quotaOf(3);
    const updates = attachAnchorQuota(Object.freeze({ is_anchor: true, topic: "t" }), quota);
    assert.deepEqual(await applyAnchorQuotaToUpdate(fakeClient(3), updates, { is_anchor: false }), { topic: "t" });
    assert.deepEqual(quota.calls, ["exceed"]);
  });

  it("표식이 없거나 이미 앵커인 행은 잠그지 않는다", async () => {
    const client  = fakeClient(9);
    const plain   = Object.freeze({ is_anchor: true });
    const marked  = attachAnchorQuota(Object.freeze({ is_anchor: true }), quotaOf(3));
    assert.equal(await applyAnchorQuotaToUpdate(client, plain, { is_anchor: false }), plain);
    assert.equal(await applyAnchorQuotaToUpdate(client, marked, { is_anchor: true }), marked);
    assert.deepEqual(client.calls, []);
  });
});

describe("applyAnchorQuotaToBatch", () => {
  function batchOf(n, mode) {
    const validFragments = Array.from({ length: n }, (_, i) => ({
      index   : i,
      fragment: attachAnchorQuota({ id: `f${i}`, is_anchor: true }, quotaOf(3, mode))
    }));
    validFragments.push({ index: n, fragment: { id: `f${n}`, is_anchor: false } });
    const results = validFragments.map(v => ({ index: v.index, id: v.fragment.id, success: true }));
    return { validFragments, results };
  }

  it("배치 안에서 지정 수를 이어 세고 상한을 넘는 항목을 일반 파편으로 낮춘다", async () => {
    const client = fakeClient(2);
    const { validFragments, results } = batchOf(3);
    await applyAnchorQuotaToBatch(client, validFragments, results);
    assert.deepEqual(validFragments.map(v => v.fragment.is_anchor), [true, false, false, false]);
    assert.deepEqual(results.map(r => r.validation_warnings ?? []), [[], ["anchorLimitExceeded"], ["anchorLimitExceeded"], []]);
    assert.equal(client.calls.filter(c => c.sql === ANCHOR_QUOTA_LOCK_SQL).length, 1);
  });

  it("enforce는 상한을 넘는 항목을 실패로 바꾸고 기록 목록에서 뺀다", async () => {
    const { validFragments, results } = batchOf(3, "enforce");
    await applyAnchorQuotaToBatch(fakeClient(2), validFragments, results);
    assert.deepEqual(validFragments.map(v => v.index), [0, 3]);
    assert.deepEqual(results.map(r => r.success), [true, false, false, true]);
    assert.match(results[1].error, /anchorLimitExceeded/);
  });

  it("표식이 달린 앵커 항목이 없으면 잠그지 않는다", async () => {
    const client = fakeClient(0);
    await applyAnchorQuotaToBatch(client, [{ index: 0, fragment: { is_anchor: true } }], [{ index: 0, success: true }]);
    assert.deepEqual(client.calls, []);
  });
});

describe("BatchRememberProcessor 앵커 판정", () => {
  /** 일괄 저장 트랜잭션 대역. INSERT 행의 is_anchor 값(행마다 15번째 열, 행 길이는 VALUES 묶음 수로 나눈다)을 모은다. */
  function batchPool(anchors, insertedAnchors) {
    return {
      connect: async () => ({
        async query(sql, params) {
          const text = String(sql);
          if (/COUNT\(\*\)::int AS count FROM .*fragments/.test(text)) return { rows: [{ count: anchors }] };
          if (text.includes("INSERT INTO")) {
            const rows   = [];
            const stride = params.length / (text.split("VALUES")[1].match(/\(\$\d+/g) ?? []).length;
            for (let i = 0; i < params.length; i += stride) {
              insertedAnchors.push(params[i + 14]);
              rows.push({ id: params[i] });
            }
            return { rows };
          }
          return { rows: [] };
        },
        release() {}
      })
    };
  }

  function processorOf({ permissions, anchors, mode = "warn" }) {
    const insertedAnchors = [];
    const gate = () => new WriteGate({
      getAnchorState      : async () => ({ permissions, anchorCount: anchors }),
      auditAnchor         : () => {},
      anchorPermissionMode: () => mode,
      anchorLimit         : () => 3,
      reviewQueue         : () => false
    });
    const proc = new BatchRememberProcessor({
      store: {}, index: { index: async () => {} }, factory: new FragmentFactory(), writeGate: gate
    });
    proc.setPool(batchPool(anchors, insertedAnchors));
    return { proc, insertedAnchors };
  }

  const items = (n) => Array.from({ length: n }, (_, i) => ({
    content: `일괄 저장 앵커 항목 번호 ${i} 를 충분히 길게 적는다`, topic: "t", type: "fact", isAnchor: true
  }));

  it("anchor 권한이 없는 키의 항목은 일반 파편으로 저장하고 항목 결과에 경고를 싣는다", async () => {
    const { proc, insertedAnchors } = processorOf({ permissions: ["read", "write"], anchors: 0 });
    const out = await proc.process({ fragments: items(2), _keyId: KEY });
    assert.deepEqual(insertedAnchors, [false, false]);
    assert.deepEqual(out.results.map(r => r.validation_warnings), [["anchorPermissionRequired"], ["anchorPermissionRequired"]]);
  });

  it("권한이 있는 키는 배치 안에서도 상한까지만 앵커로 저장한다", async () => {
    const { proc, insertedAnchors } = processorOf({ permissions: ["write", "anchor"], anchors: 1 });
    const out = await proc.process({ fragments: items(4), _keyId: KEY });
    assert.deepEqual(insertedAnchors, [true, true, false, false]);
    assert.deepEqual(out.results.map(r => r.validation_warnings ?? []), [[], [], ["anchorLimitExceeded"], ["anchorLimitExceeded"]]);
  });

  it("enforce는 권한 없는 항목과 상한을 넘는 항목을 항목 오류로 돌려준다", async () => {
    const denied = processorOf({ permissions: ["read", "write"], anchors: 0, mode: "enforce" });
    const out1   = await denied.proc.process({ fragments: items(1), _keyId: KEY });
    assert.equal(out1.results[0].success, false);
    assert.match(out1.results[0].error, /anchorPermissionRequired/);

    const limited = processorOf({ permissions: ["anchor"], anchors: 2, mode: "enforce" });
    const out2    = await limited.proc.process({ fragments: items(2), _keyId: KEY });
    assert.deepEqual(out2.results.map(r => r.success), [true, false]);
    assert.deepEqual(limited.insertedAnchors, [true]);
  });
});
