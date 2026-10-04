/** ContradictionDetector 감사 기록 의존성 주입 계약. */

import { describe, it, mock } from "node:test";
import assert                 from "node:assert/strict";

import { ContradictionDetector } from "../../lib/memory/link/ContradictionDetector.js";
import { contradictionAuditContent } from "../../lib/memory/link/contradictionAudit.js";

const winner = { id: "winner", content: "새 사실 본문" };
const loser  = { id: "loser", content: "이전 사실 본문" };
const options = { topic: "contradiction_audit", keywords: ["alpha"], logPrefix: "test" };

describe("ContradictionDetector 감사 기록 의존성", () => {
  it("주입한 rememberAudit에 기존 감사 파편 형식을 전달한다", async () => {
    const rememberAudit = mock.fn(async () => ({ id: "audit" }));
    const store         = { getTrustTiers: async () => new Map([[winner.id, 2], [loser.id, 2]]) };
    const detector      = new ContradictionDetector(store, { rememberAudit });

    await detector.recordResolutionAudit(winner, loser, "새 사실이 이전 사실을 대체함", options);

    assert.equal(rememberAudit.mock.callCount(), 1);
    const params = rememberAudit.mock.calls[0].arguments[0];
    assert.equal(params.type, "decision");
    assert.equal(params.topic, options.topic);
    assert.deepEqual(params.linkedTo, [winner.id, loser.id]);
    assert.equal(params.content, contradictionAuditContent(loser, winner, "새 사실이 이전 사실을 대체함"));
  });

  it("감사 기록 실패는 모순 해소 호출자에게 전파하지 않는다", async () => {
    const detector = new ContradictionDetector({}, {
      rememberAudit: async () => { throw new Error("audit unavailable"); }
    });

    await assert.doesNotReject(() => detector.recordResolutionAudit(winner, loser, "reason", options));
  });

  it("독립 생성 시 의존성이 없음을 명시적으로 건너뛴다", async () => {
    const detector = new ContradictionDetector({});
    await assert.doesNotReject(() => detector.recordResolutionAudit(winner, loser, "reason", options));
  });
});
