/**
 * WriteGate 되살리기 단계 교체표 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * RESTORE_STEPS는 본문 최소 품질 검사와 저장 길이 절삭만 건너뛰고, 민감 정보 마스킹과 입력 길이
 * 상한과 판정 단계는 그대로 적용한다. 보통 가져오기 게이트는 바뀌지 않는다.
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";

import { WriteGate, WriteInputError, RESTORE_STEPS, STEP_ORDER } from "../../lib/memory/write/WriteGate.js";

const check = (gate, content, extra = {}) => gate.check({
  entry: "cli_import", op: "create", mode: "production",
  fields: { content, topic: "ops", type: "fact", ...extra },
  build : (input) => ({ ...input })
});

describe("RESTORE_STEPS", () => {
  const restore = new WriteGate({ steps: RESTORE_STEPS });
  const normal  = new WriteGate();

  it("normalize와 length만 교체한다", () => {
    assert.deepEqual(Object.keys(RESTORE_STEPS).sort(), ["length", "normalize"]);
    for (const name of Object.keys(RESTORE_STEPS)) assert.ok(STEP_ORDER.includes(name));
  });

  it("짧은 본문은 보통 게이트가 거부하고 되살리기는 받는다", async () => {
    await assert.rejects(() => check(normal, "ok"), WriteInputError);
    const { draft } = await check(restore, "ok");
    assert.equal(draft.content, "ok");
  });

  it("저장 상한을 넘는 본문은 보통 게이트가 자르고 되살리기는 그대로 둔다", async () => {
    const long = "가".repeat(450);
    assert.ok((await check(normal, long)).draft.content.length < long.length);
    assert.equal((await check(restore, long)).draft.content, long);
  });

  it("되살리기도 민감 정보를 가리고 입력 길이 상한을 지킨다", async () => {
    const masked = (await check(restore, "담당자 메일은 ops-team@example.com 이다")).draft.content;
    assert.ok(!masked.includes("ops-team@example.com"));
    await assert.rejects(() => check(restore, "가".repeat(4001)), WriteInputError);
  });

  it("본문이 비어 있으면 되살리기도 거부한다", async () => {
    await assert.rejects(() => check(restore, "   "), WriteInputError);
  });
});
