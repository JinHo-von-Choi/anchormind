/**
 * batch_remember 총 문자수 게이트
 *
 * 작성자: 최진호
 * 작성일: 2026-07-16
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";
import { BatchRememberProcessor } from "../../lib/memory/write/BatchRememberProcessor.js";

/** DB에 도달하기 전 게이트에서 throw되므로 store/index/factory는 미사용 스텁으로 충분 */
function makeProcessor() {
  const factory = { create: (item) => ({ id: "x", ...item }) };
  const proc    = new BatchRememberProcessor({ store: {}, index: {}, factory });
  proc.setPool(null);
  return proc;
}

describe("batch_remember total char gate", () => {
  it("총 문자수가 상한을 넘으면 거절한다", async () => {
    const proc = makeProcessor();
    /** 4000자 이하 유효 건 60개 = 총 210,000자 > 200,000 상한 */
    const fragments = Array.from({ length: 60 }, () => ({
      content: "가".repeat(3500),
      type   : "fact"
    }));
    await assert.rejects(
      () => proc.process({ fragments }),
      /total content|exceeds maximum/i
    );
  });

  it("상한 이하 배치는 게이트를 통과한다(총량 검사 자체는 throw하지 않음)", async () => {
    const proc = makeProcessor();
    const fragments = [{ content: "짧은 사실", type: "fact" }];
    /** 총량 게이트를 통과하면 이후 경로에서 다른 사유로 실패할 수 있으나,
     *  총량 초과 메시지로는 실패하지 않아야 한다 */
    await assert.doesNotReject(async () => {
      try { await proc.process({ fragments }); }
      catch (err) { assert.doesNotMatch(err.message, /total content|exceeds maximum/i); }
    });
  });
});
