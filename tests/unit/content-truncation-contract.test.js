/**
 * 본문 절삭 계약: 절삭 사실이 경고와 응답 필드로 드러나고, 차단 대상은 아니다
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";

process.env.MEMENTO_AUDIT_DB = "off";

import {
  truncateContent,
  limitContentLength,
  MAX_FRAGMENT_LENGTH,
  MAX_EPISODE_FRAGMENT_LENGTH
} from "../../lib/memory/write/FragmentFactory.js";
import {
  lengthStep,
  isGateEligible,
  truncationInfo,
  truncationField,
  CONTENT_TRUNCATED_RULE
} from "../../lib/memory/write/WriteGate.js";

const stateOf = (fields, base = null) => ({ entry: "remember", op: "create", mode: "production", fields, base, draft: null, ctx: {}, violations: [] });

describe("truncateContent", () => {
  it("상수를 내보낸다", () => {
    assert.equal(MAX_FRAGMENT_LENGTH, 300);
    assert.equal(MAX_EPISODE_FRAGMENT_LENGTH, 1000);
  });

  for (const [type, max] of [["fact", 300], [null, 300], ["episode", 1000]]) {
    it(`${type ?? "무유형"}: ${max}자까지는 그대로다`, () => {
      const r = truncateContent("a".repeat(max), type);
      assert.deepEqual([r.truncated, r.originalLength, r.storedLength, r.value.length], [false, max, max, max]);
    });

    it(`${type ?? "무유형"}: ${max + 1}자는 잘리고 끝에 ...이 붙어 ${max + 3}자가 된다`, () => {
      const r = truncateContent("a".repeat(max + 1), type);
      assert.equal(r.truncated, true);
      assert.equal(r.originalLength, max + 1);
      assert.equal(r.storedLength, max + 3);
      assert.ok(r.value.endsWith("..."));
    });
  }

  it("잘린 값을 다시 넣어도 같은 값이다(멱등)", () => {
    const once  = truncateContent("가".repeat(2000), "fact").value;
    const twice = truncateContent(once, "fact").value;
    assert.equal(twice, once);
  });

  it("limitContentLength는 같은 문자열을 돌려준다", () => {
    assert.equal(limitContentLength("a".repeat(500), "fact"), truncateContent("a".repeat(500), "fact").value);
  });
});

describe("lengthStep 경고", () => {
  it("절삭하면 contentTruncated 위반에 원래 길이와 저장 길이를 싣는다", () => {
    const next = lengthStep(stateOf({ content: "a".repeat(2000), type: "fact" }));
    assert.equal(next.violations.length, 1);
    assert.equal(next.violations[0].rule, CONTENT_TRUNCATED_RULE);
    assert.deepEqual(next.violations[0].detail, { original_length: 2000, stored_length: 303 });
  });

  it("절삭하지 않으면 위반이 없다", () => {
    const next = lengthStep(stateOf({ content: "a".repeat(300), type: "fact" }));
    assert.equal(next.violations.length, 0);
  });

  it("episode는 1000자 기준으로 센다", () => {
    const next = lengthStep(stateOf({ content: "a".repeat(2000), type: "episode" }));
    assert.deepEqual(next.violations[0].detail, { original_length: 2000, stored_length: 1003 });
  });
});

describe("hard gate 제외와 응답 필드", () => {
  it("contentTruncated는 hard gate 대상이 아니다", () => {
    assert.equal(isGateEligible({ rule: CONTENT_TRUNCATED_RULE, severity: "low" }), false);
    assert.equal(isGateEligible({ rule: "someOtherRule", severity: "low" }), true);
  });

  it("truncationInfo는 위반 목록에서 정보를 꺼내고 없으면 null이다", () => {
    const v = { rule: CONTENT_TRUNCATED_RULE, detail: { original_length: 900, stored_length: 303 } };
    assert.deepEqual(truncationInfo(["otherRule", v]), v.detail);
    assert.equal(truncationInfo(["otherRule"]), null);
    assert.equal(truncationInfo(undefined), null);
  });

  it("truncationField는 절삭이 없으면 빈 객체라 응답이 달라지지 않는다", () => {
    assert.deepEqual(truncationField(null), {});
    assert.deepEqual(truncationField({ original_length: 900, stored_length: 303 }), { content_truncated: { original_length: 900, stored_length: 303 } });
  });
});

import { STORAGE_CONTRACT_TEXT, MAX_CONTENT_INPUT_LENGTH } from "../../lib/memory/contentGuard.js";

describe("저장 계약 문구", () => {
  it("코드 상수에서 만들어져 세 수치와 응답 필드 이름을 담는다", () => {
    for (const piece of [`${MAX_FRAGMENT_LENGTH}자`, `${MAX_EPISODE_FRAGMENT_LENGTH}자`, `${MAX_CONTENT_INPUT_LENGTH}자`, "content_truncated", "contentTruncated"]) {
      assert.ok(STORAGE_CONTRACT_TEXT.includes(piece), piece);
    }
  });
});
