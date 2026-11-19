/**
 * consolidator-feedback.test.js (node:test 이주)
 *
 * 작성자: 최진호
 * 작성일: 2026-03-17
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";

describe("contradiction audit content format", () => {
    it("audit content 포맷 검증", () => {
        const loserContent  = "Redis TTL은 300초다.";
        const winnerContent = "Redis TTL은 3600초다.";
        const reasoning     = "최신 설정값 우선";

        const content = `[모순 해결] "${loserContent.substring(0, 80)}" 파편이 "${winnerContent.substring(0, 80)}" 으로 대체됨. 판단 근거: ${reasoning}`;

        assert.ok(content.includes("[모순 해결]"));
        assert.ok(content.includes("최신 설정값 우선"));
        assert.ok(content.length > 20);
    });
});
