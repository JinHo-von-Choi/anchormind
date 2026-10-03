/**
 * 감사 해시 체인 순수 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 정규 JSON, 행 해시, 변조 검출(값 변경, 행 삭제, 행 삽입, 순서 교환, 앞부분 정리 뒤 기준점)을 본다.
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";

import {
  GENESIS_HASH, CHAIN_BREAK, AuditChainValueError,
  canonicalJson, chainRecord, computeRowHash, nextRecordedAt,
  startChainVerification, verifyChainRows
} from "../../lib/logging/audit-chain.js";

/** seq 1부터 n까지 이어진 체인 행을 만든다. */
function buildChain(n, startSeq = 1, startPrev = GENESIS_HASH) {
  const rows = [];
  let   prev = startPrev;
  for (let i = 0; i < n; i++) {
    const row = {
      seq        : startSeq + i,
      sourceEvent: `audit.record:${100 + i}`,
      occurredAt : new Date(Date.UTC(2026, 9, 3, 0, 0, i)),
      recordedAt : new Date(Date.UTC(2026, 9, 3, 0, 0, i, 5)),
      action     : i % 2 ? "memory.remember" : "admin.key.policy_update",
      outcome    : "success",
      actorKind  : i % 2 ? "key" : "master",
      actorKeyId : i % 2 ? "6f1c0f7e-0000-4000-8000-000000000001" : null,
      targetType : "fragment",
      targetId   : `frag-${i}`,
      detail     : { contentSha256: "a".repeat(64), contentLength: 10 + i, changed: ["x", "y"] }
    };
    row.prevHash = prev;
    row.rowHash  = computeRowHash(prev, row);
    prev         = row.rowHash;
    rows.push(row);
  }
  return rows;
}

const verifyAll = (rows, anchor) => verifyChainRows(startChainVerification(anchor), rows);

describe("정규 JSON", () => {
  it("객체 키 순서와 무관하게 같은 문자열이다", () => {
    assert.equal(canonicalJson({ b: 1, a: { d: [1, "x"], c: null } }), canonicalJson({ a: { c: null, d: [1, "x"] }, b: 1 }));
  });

  it("배열 순서는 보존한다", () => {
    assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
  });

  it("유한하지 않은 수와 undefined는 거부한다", () => {
    assert.throws(() => canonicalJson({ a: Number.NaN }), AuditChainValueError);
    assert.throws(() => canonicalJson({ a: undefined }), AuditChainValueError);
  });
});

describe("행 해시", () => {
  it("jsonb 왕복처럼 detail 키 순서가 바뀌어도 해시가 같다", () => {
    const [row] = buildChain(1);
    const again = { ...row, detail: JSON.parse(JSON.stringify({ changed: ["x", "y"], contentLength: 10, contentSha256: "a".repeat(64) })) };
    assert.equal(computeRowHash(GENESIS_HASH, again), row.rowHash);
  });

  it("시각은 Date와 ISO 문자열이 같은 해시를 만들고 seq는 수와 문자열이 같다", () => {
    const [row] = buildChain(1);
    const text  = { ...row, seq: "1", occurredAt: row.occurredAt.toISOString(), recordedAt: row.recordedAt.toISOString() };
    assert.equal(computeRowHash(GENESIS_HASH, text), row.rowHash);
  });

  it("앞 해시가 다르면 같은 행도 다른 해시다", () => {
    const [row] = buildChain(1);
    assert.notEqual(computeRowHash("f".repeat(64), row), row.rowHash);
  });

  it("해시 대상 값에 생략 가능한 열은 null로 들어간다", () => {
    const record = chainRecord({ seq: 3, sourceEvent: "s", occurredAt: new Date(0), recordedAt: new Date(0), action: "a", outcome: "success", actorKind: "system" });
    assert.equal(record.actorKeyId, null);
    assert.equal(record.workspace, null);
    assert.deepEqual(record.detail, {});
  });
});

describe("체인 검증", () => {
  it("온전한 체인은 끊김 없이 모든 행을 확인한다", () => {
    const result = verifyAll(buildChain(6), { prevHash: GENESIS_HASH, expectedSeq: 1 });
    assert.equal(result.broken, null);
    assert.equal(result.checked, 6);
    assert.equal(result.firstSeq, 1);
    assert.equal(result.lastSeq, 6);
  });

  it("여러 묶음으로 나눠 이어 검증해도 결과가 같다", () => {
    const rows  = buildChain(7);
    const state = verifyChainRows(verifyChainRows(startChainVerification({ prevHash: GENESIS_HASH }), rows.slice(0, 3)), rows.slice(3));
    assert.equal(state.broken, null);
    assert.equal(state.checked, 7);
  });

  it("행 값 하나를 바꾸면 그 행에서 row_hash 불일치로 끊긴다", () => {
    const rows = buildChain(5);
    rows[2] = { ...rows[2], outcome: "failure" };
    assert.deepEqual(verifyAll(rows).broken, { seq: 3, reason: CHAIN_BREAK.HASH_MISMATCH });
  });

  it("detail 안의 값을 바꿔도 검출한다", () => {
    const rows = buildChain(4);
    rows[1] = { ...rows[1], detail: { ...rows[1].detail, contentLength: 999 } };
    assert.deepEqual(verifyAll(rows).broken, { seq: 2, reason: CHAIN_BREAK.HASH_MISMATCH });
  });

  it("값을 바꾸고 그 행의 row_hash까지 다시 계산하면 다음 행의 prev_hash 연결에서 끊긴다", () => {
    const rows   = buildChain(4);
    const forged = { ...rows[1], actorKind: "system" };
    forged.rowHash = computeRowHash(forged.prevHash, forged);
    rows[1] = forged;
    assert.deepEqual(verifyAll(rows).broken, { seq: 3, reason: CHAIN_BREAK.PREV_MISMATCH });
  });

  it("가운데 행을 지우면 seq 공백으로 끊긴다", () => {
    const rows = buildChain(5);
    rows.splice(2, 1);
    assert.deepEqual(verifyAll(rows).broken, { seq: 4, reason: CHAIN_BREAK.SEQ_GAP });
  });

  it("지운 뒤 seq를 당겨 채우면 prev_hash 연결에서 끊긴다", () => {
    const rows = buildChain(5);
    rows.splice(2, 1);
    for (let i = 2; i < rows.length; i++) rows[i] = { ...rows[i], seq: i + 1 };
    assert.deepEqual(verifyAll(rows).broken, { seq: 3, reason: CHAIN_BREAK.PREV_MISMATCH });
  });

  it("두 행의 순서를 바꾸면 끊긴다", () => {
    const rows = buildChain(4);
    [rows[1], rows[2]] = [rows[2], rows[1]];
    assert.deepEqual(verifyAll(rows).broken, { seq: 3, reason: CHAIN_BREAK.SEQ_GAP });
  });

  it("체인 중간에 끼워 넣은 행은 그 뒤의 원래 행에서 끊김으로 검출한다", () => {
    const rows     = buildChain(3);
    const inserted = { ...rows[1], seq: 3, sourceEvent: "audit.record:999", prevHash: rows[1].rowHash };
    inserted.rowHash = computeRowHash(inserted.prevHash, inserted);
    rows.splice(2, 0, inserted);
    assert.deepEqual(verifyAll(rows).broken, { seq: 3, reason: CHAIN_BREAK.SEQ_GAP });
    assert.equal(verifyAll(rows).checked, 3);
  });

  it("끼워 넣은 행 뒤의 행들을 모두 다시 번호 매기고 해시하지 않으면 prev_hash 연결에서 끊긴다", () => {
    const rows     = buildChain(3);
    const inserted = { ...rows[1], seq: 3, sourceEvent: "audit.record:999", prevHash: rows[1].rowHash };
    inserted.rowHash = computeRowHash(inserted.prevHash, inserted);
    rows.splice(2, 0, inserted);
    rows[3] = { ...rows[3], seq: 4 };
    assert.deepEqual(verifyAll(rows).broken, { seq: 4, reason: CHAIN_BREAK.PREV_MISMATCH });
  });

  it("첫 행이 기준 해시와 이어지지 않으면 끊긴다", () => {
    const rows = buildChain(2);
    assert.deepEqual(verifyAll(rows, { prevHash: "1".repeat(64) }).broken, { seq: 1, reason: CHAIN_BREAK.PREV_MISMATCH });
  });

  it("앞부분이 정리된 체인은 남은 첫 행의 prev_hash를 기준점으로 받는다", () => {
    const rows   = buildChain(8).slice(3);
    const result = verifyAll(rows);
    assert.equal(result.broken, null);
    assert.equal(result.firstSeq, 4);
    assert.equal(result.anchorHash, buildChain(8)[2].rowHash);
  });

  it("끊긴 뒤의 묶음은 더 보지 않는다", () => {
    const rows = buildChain(4);
    rows[0] = { ...rows[0], action: "admin.other" };
    const first = verifyChainRows(startChainVerification(), rows.slice(0, 2));
    const after = verifyChainRows(first, rows.slice(2));
    assert.deepEqual(after.broken, { seq: 1, reason: CHAIN_BREAK.HASH_MISMATCH });
    assert.equal(after.checked, 0);
  });
});

describe("기록 시각", () => {
  it("앞 행보다 이르지 않다", () => {
    assert.equal(nextRecordedAt(1000, new Date(2000)).getTime(), 2000);
    assert.equal(nextRecordedAt(3000, new Date(2000)).getTime(), 3000);
    assert.equal(nextRecordedAt(3000, null).getTime(), 3000);
  });
});
