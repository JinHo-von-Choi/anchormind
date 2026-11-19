/**
 * EMA 감쇠 단계 실서버 시험(일회용 DB)
 *
 * 작성자: 최진호
 * 작성일: 2026-11-19
 *
 * 30~60일 미접근 파편의 EMA는 미접근 구간마다 한 번만 절반이 되고, 60일 넘은 파편은 0이 되며, 앵커는 바뀌지
 * 않는다. 주기 안에서 바꾼 값은 주기 되돌리기로 이전 값이 돌아온다.
 */
import crypto                  from "node:crypto";
import { describe, it, after } from "node:test";
import assert                  from "node:assert/strict";

const { prepareLaneDatabase, dropLaneDatabase, directQuery } = await import("./_harness.js");

await prepareLaneDatabase();

const { shutdownPool, getPrimaryPool } = await import("../../lib/tools/db.js");
const { FragmentGC }                   = await import("../../lib/memory/consolidate/FragmentGC.js");
const { runInCycle, newCycleId }       = await import("../../lib/memory/consolidate/ChangeLog.js");
const { rollbackCycle }                = await import("../../lib/memory/consolidate/ConsolidationRollback.js");

after(async () => {
  await shutdownPool();
  await dropLaneDatabase();
});

/** 마지막 접근이 days일 전이고 EMA가 ema인 파편을 넣고 id를 돌려준다. */
async function idle(days, ema, { anchor = false } = {}) {
  const id = crypto.randomUUID();
  await directQuery(
    `INSERT INTO agent_memory.fragments
       (id, content, type, topic, importance, ttl_tier, agent_id, keywords, content_hash, is_anchor,
        created_at, accessed_at, ema_activation, ema_last_updated)
     VALUES ($1, 'ema ' || $1, 'fact', 'ema', 0.5, 'warm', 'default', '{}', md5($1), $2,
             NOW() - make_interval(days => $3 + 1), NOW() - make_interval(days => $3), $4, NOW() - make_interval(days => $3))`,
    [id, anchor, days, ema]
  );
  return id;
}

async function emaOf(ids) {
  const { rows } = await directQuery("SELECT id, ema_activation FROM agent_memory.fragments WHERE id = ANY($1::text[])", [ids]);
  return Object.fromEntries(rows.map(r => [r.id, Number(r.ema_activation.toFixed(4))]));
}

describe("EMA 감쇠", () => {
  it("30~60일 구간은 한 번만 절반이 되고, 되돌리면 이전 값이 돌아온다", async () => {
    const old    = await idle(70, 0.6);
    const mid    = await idle(45, 0.6);
    const anchor = await idle(70, 0.6, { anchor: true });
    const gc     = new FragmentGC();
    const cycle  = newCycleId();

    const changed = await runInCycle(cycle, () => gc.decayEmaActivation());
    assert.equal(changed, 2);
    assert.deepEqual(await emaOf([old, mid, anchor]), { [old]: 0, [mid]: 0.3, [anchor]: 0.6 });

    await runInCycle(newCycleId(), () => gc.decayEmaActivation());
    assert.equal((await emaOf([mid]))[mid], 0.3);

    const undone = await rollbackCycle(getPrimaryPool(), cycle);
    assert.equal(undone.ema_restored, 2);
    assert.deepEqual(await emaOf([old, mid]), { [old]: 0.6, [mid]: 0.6 });
  });
});
