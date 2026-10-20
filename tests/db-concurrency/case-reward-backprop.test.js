/**
 * 사례 검증 보상의 실서버 시험(일회용 DB)
 *
 * 작성자: 최진호
 * 작성일: 2026-10-20
 *
 * 실제 행으로 다음을 확인한다.
 *   - 검증 이벤트의 근거는 이벤트와 같은 트랜잭션에 기록되고, 보상은 그 근거 파편에만 간다
 *   - 같은 사례의 다른 이벤트 근거와 contradicts 근거는 보상하지 않는다
 *   - 보상량은 delta x confidence이고, confounded(confidence <= 0.5) 근거는 quality_verified를 받지 않는다
 *   - 같은 사례를 두 번 검증해도 앞선 근거가 누적 보상되지 않는다
 */

import { describe, it, before, after } from "node:test";
import assert                          from "node:assert/strict";
import crypto                          from "node:crypto";

process.env.EMBEDDING_BASE_URL            = "http://127.0.0.1:9";
process.env.MEMENTO_CASE_BACKPROP_ENABLED = "true";

const { SCHEMA, prepareLaneDatabase, dropLaneDatabase, directQuery } = await import("./_harness.js");

await prepareLaneDatabase();

const { shutdownPool }       = await import("../../lib/tools/db.js");
const { CaseEventStore }     = await import("../../lib/memory/CaseEventStore.js");

const store  = new CaseEventStore();
const CASE   = `crb-case-${crypto.randomUUID()}`;
const fid    = () => `crb-${crypto.randomUUID()}`;

async function insertFragment(id) {
  await directQuery(
    `INSERT INTO ${SCHEMA}.fragments
            (id, content, topic, type, importance, ttl_tier, agent_id, keywords, content_hash, case_id)
     VALUES ($1, $1, 'crb-topic', 'procedure', 0.5, 'warm', 'default', '{}', md5($1), $2)`,
    [id, CASE]
  );
  return id;
}

async function state(id) {
  const { rows } = await directQuery(
    `SELECT importance, quality_verified FROM ${SCHEMA}.fragments WHERE id = $1`, [id]);
  return { importance: Number(rows[0].importance.toFixed(4)), verified: rows[0].quality_verified === true };
}

/** 보상은 append가 끝난 뒤 비동기로 돌므로 값이 바뀔 때까지 짧게 기다린다. */
async function waitFor(id, predicate) {
  for (let i = 0; i < 50; i++) {
    if (predicate(await state(id))) return;
    await new Promise((r) => setTimeout(r, 20));
  }
}

after(async () => {
  try {
    await shutdownPool();
  } finally {
    await dropLaneDatabase();
  }
});

describe("CaseRewardBackprop (실제 DB)", () => {
  let earlier, direct, confounded, contra;

  before(async () => {
    earlier    = await insertFragment(fid());
    direct     = await insertFragment(fid());
    confounded = await insertFragment(fid());
    contra     = await insertFragment(fid());
    await store.append({
      case_id: CASE, event_type: "milestone_reached", summary: "earlier", source_fragment_id: earlier,
      evidence: [{ fragment_id: earlier, kind: "produced_by" }]
    });
  });

  it("검증 이벤트의 근거만 delta x confidence로 보상하고 contradicts와 앞선 이벤트 근거는 건드리지 않는다", async () => {
    const { event_id, inserted } = await store.append({
      case_id: CASE, event_type: "verification_passed", summary: "verified", source_fragment_id: direct,
      evidence: [
        { fragment_id: direct,     kind: "produced_by" },
        { fragment_id: confounded, kind: "supports", confidence: 0.5 },
        { fragment_id: contra,     kind: "contradicts" }
      ]
    });
    assert.equal(inserted, true);

    const { rows } = await directQuery(
      `SELECT fragment_id, kind, confidence FROM ${SCHEMA}.fragment_evidence WHERE event_id = $1 ORDER BY kind`,
      [event_id]);
    assert.equal(rows.length, 3, "근거가 이벤트와 함께 기록된다");

    await waitFor(confounded, (s) => s.importance !== 0.5);

    assert.deepEqual(await state(direct),     { importance: 0.65,  verified: true });
    assert.deepEqual(await state(confounded), { importance: 0.575, verified: false });
    assert.deepEqual(await state(contra),     { importance: 0.5,   verified: false });
    assert.deepEqual(await state(earlier),    { importance: 0.5,   verified: false });
  });

  it("같은 사례를 다시 검증해도 앞선 검증 근거가 누적 보상되지 않는다", async () => {
    const again = await insertFragment(fid());
    await store.append({
      case_id: CASE, event_type: "verification_passed", summary: "verified again", source_fragment_id: again,
      evidence: [{ fragment_id: again, kind: "produced_by" }]
    });
    await waitFor(again, (s) => s.importance !== 0.5);

    assert.deepEqual(await state(again),  { importance: 0.65, verified: true });
    assert.deepEqual(await state(direct), { importance: 0.65, verified: true }, "첫 검증 근거는 그대로다");
  });

  it("verification_failed는 그 이벤트 근거만 깎는다", async () => {
    const failed = await insertFragment(fid());
    await store.append({
      case_id: CASE, event_type: "verification_failed", summary: "failed", source_fragment_id: failed,
      evidence: [{ fragment_id: failed, kind: "produced_by" }]
    });
    await waitFor(failed, (s) => s.importance !== 0.5);

    assert.deepEqual(await state(failed), { importance: 0.4,  verified: false });
    assert.deepEqual(await state(direct), { importance: 0.65, verified: true });
  });
});
